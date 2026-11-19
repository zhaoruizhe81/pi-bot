# bot 长期记忆(抽取 → 存储 → 检索)

> 目标:让每个 bot 在**每个群**里记住少量跨任务的长期偏好(口径、格式、习惯),下次接到任务时自动带上;
> 同时保持**离线可用、零向量库依赖、durable**(进 SQLite 文档,重启还在),且**永不拖慢或阻断交付**。

实现文件:`src/state/memoryStore.ts`、`src/execution/memorySection.ts`、`src/execution/memoryExtractor.ts`、
`src/state/docs.ts`(`musebot.memory`)、`src/state/groupStore.ts`(`botIdForConversation`)、
`src/app.ts`(装配 + API)、`src/execution/workItemTask.ts`(交付后触发)、`src/server/httpWs.ts`(路由)。

---

## 1. 社区实现调研(2026-11)

| 系统 | 抽取 | 存储 | 检索 | 去重 / 时效 | 对本文的影响 |
|---|---|---|---|---|---|
| **mem0** | LLM 从交互中抽事实,再对既有记忆做 ADD/UPDATE/DELETE(新版 v3 改成单次 ADD-only,降延迟) | 记忆条目 + 元数据(无必需向量库,可接多种 store) | 混合检索:语义 + BM25 关键词 + 实体匹配融合打分 | 写时用 UPDATE/DELETE 合并冲突;无置信度/证据链 | **借鉴**:交互后抽取、写时去重合并、关键词参与检索。**差异**:默认不上 LLM、无向量/实体。 |
| **Letta / MemGPT** | agent 自己通过工具编辑 core memory;后台 sleep-time agent 异步整理 | 四层:message buffer / **core memory block(常驻上下文、字符上限、可编辑)** / recall(可搜历史)/ archival(外部向量库或图) | core 直接进上下文;recall/archival 按需检索 | 块级字符上限,超了就压缩/迁移 | **借鉴**:"常驻上下文的小块" = 每 (bot,群) 一个受字符上限的 `<bot-memory>` 块。**差异**:没有 recall/archival 分层、没有 agent 自编辑、没有 sleep-time。 |
| **LangMem** | memory manager 抽取结构化记忆;区分热路径(响应时检索)与后台(抽取/固化) | profile(当前状态、可人工编辑)/ collection(可上下文召回);语义/情景/程序性 | 按需 `search` | 抽取时可做 consolidate/去重 | **借鉴**:抽取放在交付后台、按 profile 形态存小集合、相关性检索。**差异**:不做程序性记忆/提示词自动优化。 |
| **Zep / Graphiti** | episode 摄入后抽实体与关系建**双时序知识图** | 图库(节点/边),带 `t_valid / t_invalid` | 图 + 关键词 + 语义混合;时间推理 | 用"失效"代替删除,保留"以前信什么" | **借鉴**:每条记忆带 `source / at` 溯源、检索计新近度。**差异**:不建图、无实体抽取、无双时序失效,只有简单列表。 |

参考:[mem0 v3 发布说明](https://newreleases.io/project/github/mem0ai/mem0/release/ts-v3.0.0)、
[Agent Memory Architectures(Letta/MemGPT 四层)](https://github.com/MohamedAbdullah-14/prompt-to-asset/blob/main/docs/research/30-agent-memory-state/30a-agent-memory-architectures.md)、
[LangMem SDK](https://www.langchain.com/blog/langmem-sdk-launch)、
[LangMem conceptual guide](https://github.com/langchain-ai/langmem/blob/main/docs/docs/concepts/conceptual_guide.md)、
[Graphiti](https://pypi.org/project/syia-memory/)。

## 2. 选型:模仿哪几条,为什么,与它们的差异

**模仿 4 条:**

1. **交互后抽取,而非提示时抽取**(mem0 / LangMem):在 `WorkItemTask.publish` **交付成功后**才抽取,提示构建阶段只读。这样热路径零 LLM、零写,群永不因记忆变慢。
2. **常驻上下文的小块**(Letta core memory block):`memorySection` 把该 bot 在本群启用的记忆渲染进 `<bot-memory>` 块,硬上限 ~2000 字符。它就是"这个 bot 在这个群的偏好"。
3. **写时去重合并**(mem0 的 UPDATE):规范化文本完全相同、或 token Jaccard ≥ 0.82 视为同一条,只把 `score` 加一、刷新 `at`,不增长列表。
4. **关键词重叠 + 新近度排序**(mem0 hybrid / Graphiti temporal):`memorySection` 用当前请求文本与该条记忆的 token 重叠量为主、新近度为辅打分,取 top-K。

**明确不抄(与它们的关键差异):**

- **不引入向量库 / 图库**:全部落在既有 durable 文档 `musebot.memory`(SQLite),单机离线即可跑;检索用 token 重叠而非 embedding,牺牲语义泛化换取零依赖与确定性。
- **不在热路径调模型**:抽取默认纯规则;`deps.model` 是可选钩子,失败/离线自动降级到规则。
- **没有 agent 自编辑 / sleep-time 代理**:记忆只由交付后抽取和用户手工 API 写入,模型不能自己改记忆块。
- **没有双时序**:用 `at`(写入/最近强化时间)+ `score` 表达新鲜度,淘汰按低分/最旧,不保留"历史版本"。
- **上限与淘汰**:每 (bot,群) 最多 50 条,超了先淘汰 `score` 最低、再按最旧;重复提及会抬 `score`,常用偏好更不容易被淘汰。

## 3. 数据模型

durable doc family `musebot.memory`,key = `` `${groupId}::${botId}` ``:

```ts
type MemoryDoc = {
  groupId: string;
  botId: string;
  enabled: boolean;          // 该 bot 在本群是否启用记忆(关掉就不抽取、不注入)
  items: {
    id: string;
    text: string;            // 一句话偏好 / 结论
    kind: string;            // preference / instruction / conclusion / fact
    source: string;          // requirement / delivery / model / manual
    at: number;              // 写入或最近一次强化时间
    score: number;           // 强化计数(重复提及 +1),也是淘汰主键
  }[];
};
```

存在即"有记忆";不存在等价于 `{ enabled:true, items:[] }`(读不打补丁,`get` 返回默认视图)。

## 4. 抽取(`memoryExtractor.ts`)

交付成功后从 **需求 + 任务标题 + 交付正文** 抽 0-3 条:

- **需求句**:含触发词(记住 / 以后 / 今后 / 偏好 / 喜欢 / 不喜欢 / 习惯 / 口径 / 统一用 / 默认 / 约定 / 一律 / 始终 …)的句子抽为 `preference|instruction`,`source=requirement`。
- **交付正文**:只抽**显式结论句**(以「结论 / 口径 / 决定 / 建议 / 约定 / 注意 / 规范 / 以后 / 默认」开头,或含「统一口径 / 约定如下 / 以后都 / 默认用」),`kind=conclusion`,`source=delivery`。
- **跳过一次性任务细节**:普通任务句(如"出季度财报:拉数据、做图、写结论")既无触发词也非结论句,不落库。
- 单条 ≤ 200 字;批次内规范化去重;最多 3 条;每条 `store.add` 再和已存记忆去重。
- 可选 `deps.model(delivery) => [{text,kind}]`:有就并入,抛错/离线则忽略——**绝不因模型失败影响主流程**;`afterDelivery` 内部全 try/catch,交付任务状态不受影响。

## 5. 检索与注入(`memorySection.ts`)

- 每个 bot 的私有会话才注入:`input.conversationId` 经 `groupStore.botIdForConversation` 反查 `(groupId,botId)`(启动建索引);群黑板/编排会话查不到 → 不注入。
- 该 bot 在本群**未启用**或列表为空 → 返回 `undefined`(整段省略)。
- 打分 = 与当前请求(会话里最新 `pi.user` 文本)的 token 重叠量 + 0.5 × 新近度;取 top-6,渲染 `- [kind] text`,整体截断到 ~2000 字符。
- 输出被框架包成 `<bot-memory>…</bot-memory>` 注入 system prompt。**只读,不触发 run**。

示例注入块(实测):

```
<bot-memory>
你在这个群记住的长期偏好(遵守即可,不需要复述):
- [preference] 以后所有财务数字统一用万元,保留两位小数
</bot-memory>
```

## 6. 存储 API(`memoryStore.ts`)

`get / list / add / remove / clear / setEnabled`:

- `add(groupId,botId,{text,kind?,source?})`:文本必填、≤500 字;重复 → 强化(`score+1`,`at=now`);新增 → 追加;超 50 条 → 淘汰低分/最旧。
- `remove` 按 id 删;`clear` 清空列表;`setEnabled` 切开关。
- 全部通过 `harness.commit`,与现有文档一致(整份 base,`checkpointWhen: alwaysBase`)。

## 7. HTTP 路由(`httpWs.ts`)

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/groups/:id/bots/:botId/memory` | `{enabled, items}` |
| POST | `/api/groups/:id/bots/:botId/memory` `{text,kind?}` | 新增/强化,返回新列表 |
| DELETE | `/api/groups/:id/bots/:botId/memory/:memId` | 删除,返回新列表 |
| PUT | `/api/groups/:id/bots/:botId/memory` `{enabled}` | 开关,返回新列表 |

`botProfile()` 额外返回 `memory: { enabled, count }` 摘要;完整列表走上面的 GET。未知群 404、未知 bot 409、缺 `text` 409。

## 8. 离线验证

```bash
cd bot
MUSEBOT_FAUX=1 MUSEBOT_DB=:memory: PORT=18999 \
  timeout 20 node --experimental-strip-types src/main.ts &

BOT=$(curl -s localhost:18999/api/bots | node -pe 'JSON.parse(require("fs").readFileSync(0)).bots[0].id')
GID=$(curl -s localhost:18999/api/groups | node -pe 'JSON.parse(require("fs").readFileSync(0)).groups[0].id')

curl -s localhost:18999/api/groups/$GID/bots/$BOT/memory
curl -s -X POST localhost:18999/api/groups/$GID/bots/$BOT/memory \
  -H 'content-type: application/json' -d '{"text":"以后周报统一用中文,标题用【周报】","kind":"preference"}'
# 再发一次同义句 → items 不增加,score 变 2
curl -s -X PUT localhost:18999/api/groups/$GID/bots/$BOT/memory \
  -H 'content-type: application/json' -d '{"enabled":false}'
```

交付后自动抽取也能验证:发一条含"记住/以后/统一口径"的需求,任一被派单 bot 交付后,
`GET .../memory` 就能看到它从需求里抽到的那条偏好(`source=requirement`)。

## 9. 边界

- 记忆是**每个 bot 每个群**一份,不跨群共享(跨群共享属于"全局面板",当前不做)。
- 检索是关键词/新近度启发式,不做语义 embedding;换同义词可能召不回,这是"零依赖离线"的取舍。
- 没有记忆编辑历史与回滚:删除即删除,`score/at` 只表达新鲜度。
- 记忆只影响该 bot 的私有会话 prompt,不进群黑板、不改变群消息可见内容。
