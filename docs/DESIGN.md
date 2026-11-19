# musebot v1 — 设计文档与模块划分

> 状态:**设计收口,实现到 M3.6**(M1 – M3.6 全部通过验收;剩余项见 §16)
> 版本:**v1.9**(持久化 / 多群 / 真模型 / 领导真分工 / 取消·成员·分页·真工具·多进程 / 个人资料·自定义 bot·通讯录·IM 桥·文件归档·设置与网络 已落地)
> 底座:pi-durable(本地源码版)/ pi-ai / chord
> 目标:仿微信群聊的 bot 客户端,**核心差异化 = 群不卡会话的多 agent 编排**
> 配套:入口与运行 [README.md](../README.md);pi-durable API 参考 [API.md](./API.md)

---

## 1. 目标

仿微信的群聊/单聊界面,群里有人 + 多个独立 agent 的 bot。领导 bot 把人的需求编排成**带依赖的任务图**,分派给**空闲**的 bot;群里只看到**交付 / 状态 / 编排卡**;执行细节不外泄;全程**不卡会话**。

### 1.1 不卡会话的硬指标(M1 起一直守)

1. 多群;5 个 bot(1 领导 + 4 执行)可增减;真模型(可切 faux)。
2. 人发需求 → 领导产出**计划卡**(分工 capability + 依赖;最终 assignee 以 `assigned` 卡为准)。
3. 按 deps 派活:无依赖并行、有依赖串行;bot 群内单线程,忙则改派空闲同类,无空闲则排队并**自轮询重派**。
4. 群只显示 `chat.message` + 工作卡;**工具/推理不进群**;交付是成品文本 + 文件。
5. **多个 bot 跑长任务期间,人仍能发消息、派新活、取消单项,立即受理、无 timeout、无队列卡顿。**
6. 交付卡陆续回群;刷新/重连/换进程都不丢状态(durable)。

---

## 2. 设计原则(6 条)

1. **执行私有,发布结构化**:reasoning / tool call 在各自 Conversation;群里只发布工作事件卡。
2. **群 = 黑板,绝不承载执行**:群会话**永不 `submit({type:"input"})`**;只 `write`。管家发言也是 `write` 一条 `chat.message`。群永远没有 run,不会 busy。
3. **异步派单 + 结算回贴**:派活即返回;WorkItemTask 在 phase 里 `submit` 后 `sleeping` 等 `SubmissionSettled`,不阻塞任何调用方。
4. **bot 单线程,跨 bot 并行**:每 bot 一条 Conversation;busy 直接读该会话的 `LiveDoc.run`(pi-durable 保证 run 存在即忙)。
5. **编排可见**:分工 / 依赖 / 顺序 / 状态是一等公民;执行细节不进群。
6. **复用不重写**:agent 运行时、持久化、流式、任务、信号全用 pi-durable。

---

## 3. 系统分层

```
┌ 前端 wx 壳 ───────────────────────────────────────────────┐
│ 群列表 · 聊天流 · 工作卡 · 计划卡 · 分页 · 取消 · 文件    │
└───────────────────────────▲───────────────────────────────┘
                 WS / HTTP(只投影 chat + work.event)
┌ 接入层 server ────────────┴───────────────────────────────┐
│ /send · /requirements · /stream · 静态托管 web/           │
└───────────────────────────▲───────────────────────────────┘
┌ 发布/黑板层 publish ──────┴───────────────────────────────┐
│ 群频道(只 write)· 工作卡 · Artifact                      │
└───────────────────────────▲───────────────────────────────┘
┌ 编排层 orchestration ─────┴───────────────────────────────┐
│ 领导 planner · scheduler(含 cancel)· 规则 router          │
│ 忙闲:直接读各 bot 会话的 LiveDoc.run                      │
└───────────────────────────▲───────────────────────────────┘
┌ 执行层 execution ─────────┴───────────────────────────────┐
│ WorkItemTask(wait_deps → dispatch → publish)              │
│ 在 bot 私有 Conversation 里跑;transcript 不外泄            │
│ 交付:回答文本 + workspace 里 write_file 写出的文件         │
└───────────────────────────────────────────────────────────┘
        全部落在 pi-durable Harness(SQLite 持久化)
```

---

## 4. 领域模型

| 实体 | 说明 | 载体 |
|---|---|---|
| **Bot** | 独立 agent;单线程 | 配置 + 一条 Conversation |
| **UserProfile** | 真人昵称、签名、头像 | `musebot.user-profile`(session 文档) |
| **CustomBot** | 用户创建的 bot:名称、能力、指令、头像 | `musebot.custom-bot` + `musebot.bot-directory` |
| **BotIdentity** | 内置/自定义 bot 的全局名字与头像覆盖 | `musebot.bot-identity`(session 文档) |
| **Settings / ImBridge** | 全局模型/监听地址;每群 IM token 与启用状态 | `musebot.settings` / `musebot.im-bridge`(session) |
| **Group** | 群:roster、规则、话题 | `defineDocFamily`(session) |
| **GroupPin** | 群公告 / 群置顶:全群 bot 的共享上下文 | `GroupPinDoc`(session 文档)+ prompt section |
| **WorkItem** | 一次派活:planId、key、subject、capability、assignee、deps、status、taskId | **durable `Task`** + 投影文档 |
| **Artifact** | 交付物:模型正文 + `files[]`(工作区文件) | `musebot.artifact` 文档,id = `a-<workItemId>` |
| **Workspace** | 每个 bot 会话的交付目录 | 文件系统 `data/workspace/<conversationId>/` |
| **WorkEvent** | 群里唯一可见的工作卡(含 `planning`/`cancelled`) | entry `work.event`(write) |

**WorkItem 状态机**

```
blocked(等依赖 / 无空闲 bot) → queued → running → delivered → done
                                            ↘ failed
任意非终态 ──cancel──→ cancelled(abort phase 写卡)
```

**关键:WorkItem = durable Task**;投影文档(`musebot.work-graph`)只是给 API/测试读的镜像。

---

## 5. 模块划分

```
A. protocol      类型 / 事件 / 计划校验
B. state         harness / bot 注册表 / 群与置顶文档 / 工作图 / bot 忙闲
C. orchestration 领导分工 / 调度(含取消)/ 路由(stub 规则)
D. execution     WorkItemTask(私有会话执行)/ 群 runtime / 工作区 / 写文件工具
E. publish       群黑板 / 工作卡 / 交付物 / 回答抽取
F. server        HTTP + WS + 静态托管 + 只读模式
G. web           wx 壳(群列表 / 卡片 / 分页 / 取消 / 文件)
H. obs           console / harness.inspect(未接 telemetry)
```

> 约定:凡触碰 pi-durable 的调用,**末位带 `ctx: Context`**(`@earendil-works/chord/context`)。纯配置查询除外。

### A. protocol(`src/protocol/`)
| 编号 | 文件 | 职责 |
|---|---|---|
| A1 | `types.ts` | `BotConfig / WorkItem / Artifact / Plan / PlanItem / Speaker / WorkStatus`(文档形状已搬到 `state/docs.ts`) |
| A2 | `events.ts` | `ChannelEntry = ChatMessage | WorkEvent`(`ev` 折进 `data`,是合法 `EntryDraft`) |
| A3 | `plan.ts` | `validatePlan`(环校验)、`topoOrder`、`resolvePlan`(key → WorkItemId) |

> **signal key 是一次性的**:pi-durable 消费过的 key 不能再 sleep,重复投递恒为 `duplicate`;所以没有"常驻 task 反复睡同一个 key"的设计,派单用 `SubmissionSettled` + 自轮询。

### B. state(`src/state/`)
| 编号 | 文件 | 关键接口 | 原语 |
|---|---|---|---|
| B1 | `harness.ts` | `openHarness(config, ctx)`:faux / 真网关、`readOnly`、超时与重试、SQLite 目录 | `Harness.open`、`openNodeSqliteStorage` |
| B2 | `botRegistry.ts` | `get / all / byCapability / leader`(**纯内存,无 ctx**) | — |
| B3 | `groupStore.ts` | `load / refreshAll / list / get / ensure / addMember / removeMember / pin / setAnnouncement / addPin / removePin / groupIdForConversation / botIdForConversation` | `defineDoc*`(session) |
| B4 | `workGraph.ts` | `workItemId / list / get / mutate(tx,…) / transition(tx,…) / syncPlan(plan, taskIds, ctx)` | 投影文档(每群一份) |
| B5 | `botActivity.ts` | `isBusy(botId, ctx)`、`chooseIdle(cap, ctx)`、`has(botId)` | **读 `LiveDoc.run`**;只在本组成员里挑人 |
| B6 | `docs.ts` | 13 个文档定义:`directory / group / group-pin / work-graph / artifact / settings / im-bridge / user-profile / bot-directory / custom-bot / bot-identity / bot-profile / memory` | `defineDoc` / `defineDocFamily` |
| B7 | `memoryStore.ts` | `get / list / add / remove / clear / setEnabled`;去重(规范化 + token Jaccard)、上限 50、淘汰低分/最旧 | `musebot.memory`(每 bot 每群一份) |

> **文档必须满足 `JsonObject`**:形状写 `JsonObjectLike & {…}`;缺省字段用空串而不是 `undefined`,draft 好写。
> **坑**:往 draft 数组里 `push` 的普通对象**不被追踪**,后续 `row.x = …` 不落盘 —— 构造完整对象再 push。

### C. orchestration(`src/orchestration/`)
| 编号 | 文件 | 关键接口 | 说明 |
|---|---|---|---|
| C1 | `router.ts` | `route(input, ctx) → { respond, speaker }` | 规则版,**未接 Jev**(明确推迟) |
| C2 | `planner.ts` | `plan(groupId, requirement, bots, ctx) → Plan` | 调群内领导会话,输出 JSON 契约;解析失败回退固定四步 |
| C3 | `scheduler.ts` | `submitPlan(plan, ctx)`、`cancel(groupId, workId, ctx)`、`dispatchReady(ctx)`(空) | 建任务 / 回贴 / 取消(同时停 bot) |
| C4 | `dispatcher.ts` | `ensureRunning(ctx)` | **预留**;实际靠 WorkItemTask 自轮询(见 §7.3) |

### D. execution(`src/execution/`)
| 编号 | 文件 | 关键接口 | 说明 |
|---|---|---|---|
| D1 | `workItemTask.ts` | `createWorkItemTask(deps)` | phase `wait_deps → dispatch → publish`;`abort` 写取消卡;dispatch 清工作区、publish 扫文件 |
| D2 | `groupContext.ts` | `createGroupPinSection(deps)` | 群公告/置顶注入 prompt;只读,不触发 run |
| D3 | `groupRuntime.ts` | `openGroupRuntime(deps)` → runtime | 每群装配:会话、channel、activity、scheduler;`attachBot / detachBot` 支撑成员增删 |
| D4 | `workspace.ts` | `createWorkspace(root)`:`reset / ensure / write / list` | 每会话一个目录,`safeRelativePath` 防穿越 |
| D5 | `fileTool.ts` | `createWriteFileTool(workspace)` | `write_file` 工具,`replay: "safe"`,**必须装进 registry** |
| D6 | `memorySection.ts` | `createMemorySection(deps)` | 把该 bot 在本群启用的记忆按相关度注入 `<bot-memory>`;只读,不触发 run |
| D7 | `memoryExtractor.ts` | `createMemoryExtractor(deps).afterDelivery(delivery, ctx)` | 交付后从需求+标题+正文抽 0-3 条长期记忆;规则优先,可选模型,失败降级 |

### E. publish(`src/publish/`)
| 编号 | 文件 | 关键接口 |
|---|---|---|
| E1 | `groupChannel.ts` | `append(entry, ctx)`、`speak(text, author, ctx)`(**都是 write**) |
| E2 | `workCards.ts` | `planCard / assignedCard / startedCard / blockedCard / deliveredCard / doneCard / failedCard / cancelledCard` |
| E3 | `artifacts.ts` | `put({…, files}, ctx) / get(id, ctx)`;id 由 workItemId 派生(幂等) |
| E4 | `answer.ts` | `readAnswer(conv, ctx)`:取最新 `pi.assistant` 文本,12k 字截断 |

### F. server(`src/server/`)
| 编号 | 文件 | 关键接口 |
|---|---|---|
| F1 | `httpWs.ts` | `startServer({port, staticDir, fallbackStaticDir, readOnly}, deps)`;见 §5.5 路由表 |
| F2 | `streamBridge.ts` | 预留(未使用) |

### G. web(`web/`)/ H. obs
- G:仿微信;左群列表 + 聊天流 + 计划卡/工作卡;分页「加载更早」、卡片「取消」、交付文件列表与预览。成员增删、个人资料、新建 bot、通讯录都有真 UI。
- H:`console` + `harness.inspect()` 手动排查;telemetry 未接。

### 5.1 M2 落地:SQLite 持久化 + 多群

**存储真源**:群、群置顶、工作图、交付物全部是 pi-durable 文档;进程内只剩 `conv -> group` 的只读索引缓存。

| 文档 | kind | 键 | 内容 | 写入者 |
|---|---|---|---|---|
| 目录 | `musebot.directory` | 单例 | `{ids: string[]}` | `groupStore.ensure` |
| 群 | `musebot.group` | groupId | meta + `groupConversationId` / `orchConversationId` / `botConversations` | `groupStore.ensure` |
| 群置顶 | `musebot.group-pin` | groupId | `announcement` + `pins[]` | `groupStore.setAnnouncement / addPin` |
| 工作图 | `musebot.work-graph` | groupId | `items[]`(JSON 行,空串代表缺省) | scheduler + WorkItemTask |
| 交付物 | `musebot.artifact` | `a-<workItemId>` | 文本交付 + `files[]`(路径/字节/预览) | `artifacts.put` |
| 个人资料 | `musebot.user-profile` | 单例 | `name / signature / avatar(data URL) / updatedAt` | `profileStore.set` |
| bot 目录 | `musebot.bot-directory` | 单例 | `{ids: string[]}` | `customBotStore.create` |
| 自定义 bot | `musebot.custom-bot` | botId | `name / capabilities / instructions / avatar / createdAt` | `customBotStore.create` |
| bot 身份 | `musebot.bot-identity` | 单例 | `bots[id] = {name, avatar, updatedAt}` | `botIdentityStore.set` |

**关键决策**

1. **家族不能枚举** → 用一个单例目录列 key;启动时读目录 + 每群文档,重建 `convToGroup`。
2. **建群 = 一个 commit**:群文档 + 黑板会话 + 编排会话 + N 个 bot 私有会话一起落盘,崩溃不会留半个群;会话 id 写进文档,重启**复用**(测试断言 id 不变)。
3. `ConversationId` 是 `number`,文档里存 `string`,读时 `Number()`。
4. **每群一套 bot 私有会话** → 同一个 bot 在两个群上下文互不串;忙闲也按群判定(`LiveDoc.run` 仍是唯一真相)。代价是"bot 全局单线程"变成"群内单线程";要全局单线程需在 activity 上加锁。
5. **WorkItemTask 只注册一次**(version 不升):群从 `input.groupId` 解析 runtime;图的 `syncPlan/transition` 与卡片 `appendEntry` 在**同一 commit**(`tx.doc` 与 `tx.appendEntry` 可共存)。
6. **artifact id 由 workItemId 派生** → publish 崩溃重跑幂等,不会产出第二个交付物。
7. 默认存储 `<bot>/data/musebot.sqlite`(`MUSEBOT_DB` 覆盖,`:memory:` 仍可);SQLite 目录自动创建。
8. **多群并发**由测试验证:两群同时派单,`two submits ms ≈ 20`,4/4 + 4/4 全部 done,重启后仍 done。

### 5.2 M2.5 落地:真模型(不启用 Jev)

| 项 | 实现 |
|---|---|
| Provider | `src/config/model.ts` 自建 `musebot` provider(`openai-completions` API),baseUrl/Key/模型都由 env 覆盖 |
| 默认模型 | `workbuddy/deepseek-v4.1-flash` @ `http://192.168.1.149:3425/v1`(`MUSEBOT_BASE_URL` / `MUSEBOT_API_KEY` / `MUSEBOT_MODEL` 可改) |
| 路由 | **仍是规则**(`router.ts`);Jev 分类器留到下一步 |
| 规划 | **仍是脚本计划**(`planner.ts`);领导真规划下一步 |
| 交付物 | `publish` 阶段读 bot 私有会话最新 `pi.assistant` 的文本(`publish/answer.ts`,上限 20k 字),放进交付卡;空回复才回退到占位文案 |
| 任务提示词 | `需求 + 你负责的任务 + 上游交付(每个 ≤1.5k 字)+ 直接给成品` —— 依赖真正变成上下文,而不只是排队顺序 |
| 超时/重试 | `settings.stream.timeoutMs = 90s` + `retry{maxRetries:1}`:网关卡住时失败重试,而不是把 bot 永久占住 |
| 离线 | `MUSEBOT_FAUX=1` 回到 faux;`workDelayMs` 只对 faux 生效 |

实测:真实网关一次完整计划 4/4 done 约 12–110s(串行链越长越慢,网关偶发抖动);一次网关静默卡死(`bytes_in` 停在 853B)通过进程重启 + `requestId` 幂等恢复,W2/W3 补齐且无重复交付。

### 5.3 M2.6 落地:领导真分工(不是项目规划)

领导 bot 不再套脚本模板,改成**自己拆任务**,但只拆任务:

- **提示词就是全部逻辑**(`config/bots.ts` 的 leader instructions + `planner.ts` 的 `composePrompt`):
  只做任务分工,不做排期/里程碑/预算/风险;输出一个 JSON 对象。
- **契约**:`{"items":[{"key","subject","capability","deps"}]}`,2–4 条,按顺序;`deps` 只能引用前面的 key;`capability` 必须是花名册里有的能力。
- **规则三条**:确实需要上一步产出才写 deps(能并行就并行);每个能力只有一个同事,同一能力两条任务会排队,尽量分给不同能力;subject 动词开头、≤20 字。
- **容错**:模型回包可能带解释/围栏 → 取首尾花括号解析;非法能力/环/前向引用 → 丢弃该条,再跑 `validatePlan`;仍不合法就退回固定四步(`fallbackPlan`),需求永远不会因为解析失败而卡死。
- **不阻塞**:`requirement()` 先把需求写成**群里的真人消息**(durable),再追加一张 `planning` 卡,然后异步让领导分工;HTTP/WS 立即返回(实测 9ms)。
- **前端**:新增 `planning` 卡片样式(灰),历史里能看到"需求 → 正在分工 → 计划"的完整链路。

实测(真实网关):
- "帮我出一份 Q3 季度财报,给老板汇报用" → `W1 汇总Q3财务原始数据(data) → W2 编制Q3季度财务报表(finance) → W3 分析Q3财务与经营表现(analysis) → W4 制作汇报用财报演示稿(design)`
- 加上"尽量分给不同能力"后,同一个需求拆成 2 条并行能力,整轮 11.5s 完成。

### 5.4 M3 落地:取消 / 成员 / 分页 / 真工具 / 多进程

| 能力 | 实现 | 验收 |
|---|---|---|
| 取消单个任务 | `scheduler.cancel(groupId, workId, ctx)`:`abortTask` → abort phase 写 `cancelled` 卡 + 图状态;同时 `conv.abort()` 停掉那个 bot 的生成(群内单线程,不会误伤其他任务) | `features:accept`:marked → cancelled 卡 → 二次取消返回 terminal;浏览器点「取消」即出卡 |
| 群成员增删 | 成员表在 `GroupDoc.roster`;加入时在同一 commit 建会话并写 `botConversations`,离开时只摘除名册(会话保留,重加复用);runtime 的 `botConversations` 是唯一"在场"真相,activity 只在本组成员里挑人 | `features:accept`:remove → roster 不含 → re-add 复用同一会话 id;未知 bot 被拒;busy 的 bot 拒绝移出 |
| 消息分页 | `app.items(groupId, {limit, before})` 直接透传 `conv.entries` 的 cursor;HTTP `?before=` + WS state 帧带 `next`;前端"加载更早"就地插入并保持滚动位置 | 120 条消息 → 首屏 100 + next;点"加载更早"追加 25 条,顶部变最老一条 |
| 真工具 | `write_file` 工具(registry 安装)写到 `data/workspace/<conversation>/`;dispatch 前清空该目录,publish 扫描成 `files[]` 挂到交付消息下的文件气泡(文件名/大小),点开预览、下载或查看归档 | 真实网关:一次计划交付 `report.md` 9.2KB、`data/q3-metrics.csv` 1.7KB |
| 多进程 | 单写多读:`MUSEBOT_READONLY=1` 以 `readOnly` 打开,不 resume、不配置;`documentRetentionMs: 0` + 轮询 `refreshAll()`(默认 3s)把别进程写的群广播出来;只读进程写接口一律 403 | 双进程同库:viewer 启动即看到 2 群;writer 新建"第三群"后 1s 内 viewer 列表出现;viewer 写 403,读历史正常 |

**三个踩过的坑(写下来防复发)**

1. **draft 里 push 进去的普通对象不被追踪**:`doc.items.push(blankRow())` 之后再改 `row.taskId` 不会落盘。必须构造完整对象再 push。
2. **`TaskId` / `ConversationId` 是 number**:文档里存 string,调用前 `Number()`。
3. **工具必须由 extension 装进 registry**:`configure({tools:[x]})` 只是过滤器,本地定义的 tool 不装 registry 时 `agent.tools` 为空——模型会自己编出 `<||DSML||>` 假调用。

**已知限制(截至 v1.9)**
- 所有文档 `checkpointWhen: () => true`(每次写全量 base),适合当前小文档;更大状态再换 delta。
- 跨进程群列表是**轮询**(默认 3s),不是推送;`watchDoc` 只看本进程提交。
- 成员增删、个人资料、新建 bot 已有 UI;交付文件可预览、下载、归档。
- 多写进程未支持(单写多读)。
- Jev 路由、规划质量仍推迟。

---

### 5.5 Web UI(v0.4.1,对齐微信桌面端)

- 三栏 `56 / 250 / minmax(0,1fr)`;时间行按 `data.at` 居中;气泡无尾巴;发送是文字按钮。
- 工作事件就是消息(微信里不会出现 HTML 卡片):计划是领导的一条 `@bot` 消息,交付是执行 bot 的一条 `@我` 消息 + 文件气泡,开始/排队/失败/取消是一行居中灰字。
- 增量渲染(同前缀只 append);全量重建时恢复 `details[open]`,有选区不重建。
- 未读/置顶/搜索/滚动/草稿:localStorage(`mb.read.*` / `mb.pins` / `mb.scroll.*` / `mb.draft.*`)。
- **只有一个输入框和一个「发送」**:`app.chat()` 判定"像不像请求"(`@领导` 或 动作+对象),像就交给领导分工,不像就是普通消息;`/send` 与 `/requirements` 仍保留给脚本。
- 派单(`assigned`)与完成(`done`)不显示;其余过程都是一行居中灰字,不把聊天变成看板。
- 群信息是**右侧边栏**(点头部「…」或群名滑出,不是居中弹窗),里面公告/置顶/名称/成员都可读写:公告与置顶写入 `musebot.group-pin`,由 `groupContext` 段注入每个 bot 的 prompt;改它们只改"团队共识",**不触发任何 run**。昵称/备注/免打扰只在自己浏览器里(`mb.nick` / `mb.remark` / `mb.mute`)。
- 左栏群列表下方是可折叠的**我的 bot** 段(`GET /api/bots` + 当前群 roster,`mb.botsCollapsed`),每个 bot 显示头像/名字/能力/是否在群里;无需打开通讯录也能看到 bot。群置顶区用微信式 `N个置顶聊天` 折叠行(`mb.pins.collapsed`)。
- 「通讯录」是 bot 地址簿的两栏窗口(左列表 + 右资料),不是微信好友/朋友圈模拟;右栏「发消息」把 `@名字` 放进输入框,「打开设置」进入 bot 抽屉,「加入本群」调用成员接口。
- 规格与验收:`docs/WEBUI.md`;参考图 `docs/ref-wechat.png`;截图 `docs/webui-*.jpg`。

### 5.6 接口与帧

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/groups` | 群列表(`cache-control: no-store`) |
| `POST` | `/api/groups` | 建群 `{name}` |
| `GET` | `/api/groups/:id` | 群详情:`group / members[{id,name,role,capabilities,busy}] / announcement / pins` |
| `GET` | `/api/groups/:id/items?limit=&before=` | 一页历史;`before` 是上次的 `next`(JSON 字符串) |
| `POST` | `/api/groups/:id/send` | 真人发言 `{text}` |
| `POST` | `/api/groups/:id/requirements` | 派需求(立即返回,领导异步分工) |
| `POST` | `/api/groups/:id/work/:workId/cancel` | 取消单个任务 |
| `POST` | `/api/groups/:id/members` | 加成员 `{botId}` |
| `DELETE` | `/api/groups/:id/members/:botId` | 移成员(busy 或领导 409) |
| `PUT` | `/api/groups/:id` | 改群名 `{name}`,返回群详情 |
| `PUT` | `/api/groups/:id/announcement` | 改群公告 `{text}`,返回群详情 |
| `POST` | `/api/groups/:id/pins` | 加群置顶 `{text,by}`,返回群详情 |
| `DELETE` | `/api/groups/:id/pins/:pinId` | 删群置顶,返回群详情 |
| `GET` | `/api/bots` | 全部 bot(`id/name/role/capabilities/avatar/custom`)+ 可创建的能力列表 |
| `POST` | `/api/bots` | 新建 bot `{name,capability,instructions,avatar?,groupId?}`;带 groupId 时同一次调用入群 |
| `GET` | `/api/profile` | 个人资料 `{name,signature,avatar,updatedAt}` |
| `PUT` | `/api/profile` | 保存个人资料;avatar 只收 base64 图片 data URL(≤240KB) |
| `POST` | `/api/groups/:id/uploads` | 发送文件/图片/语音 `{name,mime,data(base64)}`,落 `chat.file` 条目 |
| `GET` | `/api/groups/:id/im` | IM 桥配置(token 掩码) |
| `PUT` | `/api/groups/:id/im` | 启用/停用 IM 桥 |
| `POST` | `/api/groups/:id/im/rotate` | 重新生成 token(完整值只回这一次) |
| `POST` | `/api/im/:groupId/:token` | IM 入站消息 `{sender,text}`,走与输入框相同的 router |
| `GET` | `/api/im/:groupId/:token/outbox?since=` | 出站拉取(id 升序,≤200 条) |
| `GET` | `/api/groups/:id/uploads/:fileId` | 下载/播放一个上传文件 |
| `GET` | `/api/groups/:id/bots/:botId` | 单个 bot 的面板数据(提示词/模型/交付/所在群) |
| `PUT` | `/api/groups/:id/bots/:botId` | 写该 bot 在本群的提示词/模型覆盖,或全局名字/头像 `{instructions?,model?,name?,avatar?}` |
| `GET` | `/api/groups/:id/bots/:botId/memory` | 该 bot 在本群的长期记忆 `{enabled, items[]}` |
| `POST` | `/api/groups/:id/bots/:botId/memory` | 新增/强化一条记忆 `{text,kind?}`,返回新列表 |
| `DELETE` | `/api/groups/:id/bots/:botId/memory/:memId` | 删除一条,返回新列表 |
| `PUT` | `/api/groups/:id/bots/:botId/memory` | 启用/停用 `{enabled}`,返回新列表 |
| `GET` | `/api/settings` | 生效的模型配置(key 掩码) |
| `PUT` | `/api/settings` | 保存模型配置并热切换 `{api,baseUrl,modelId,apiKey?}` |
| `POST` | `/api/settings/check` | 真实探测 `${baseUrl}/models`,返回延迟与模型是否在列 |
| `GET` | `/api/status` | 进程/存储/归档/群与 bot 计数等运行事实 |
| `GET` | `/api/devices` | 监听地址、可访问 URL、Tailscale 状态、已连接浏览器 |
| `PUT` | `/api/network` | 改监听地址 `{host}`(重启生效) |
| `POST` | `/api/tailscale/serve` | 开/关 `tailscale serve` 映射 `{enabled}`(失败返回命令原文) |
| `GET` | `/api/groups/:id/files/:workId/<path>` | 下载一个已归档的交付文件;`?inline=1` 时文本类内联(预览用) |
| `GET` | `/api/groups/:id/export?format=md\|json` | 整群历史导出一份文件(md 给人看,json 做归档) |
| `WS` | `/stream?g=<groupId>` | 下行 `{type:"groups"}` + `{type:"state",groupId,items,next}` + `{type:"detail",groupId,detail}`(公告/置顶/成员变更);上行 `{type:"send"\|"requirement",text}` |

所有 entry 的 `data` 带 `at`(毫秒);`/api/groups` 每项带 `last{id,kind,ev,text,subject,error,at}`;
`POST .../send` 可带 `author` 与 `at`(导入历史/多真人用)。

只读进程(`MUSEBOT_READONLY=1`)对一切非 `GET` 返回 **403**;WS 上行回 `{type:"error"}`。

---

### 5.7 设置与模型热切换

- 设置落在 `musebot.settings` 单文档(`api / baseUrl / modelId / apiKey / updatedAt`);没写过时用环境变量兜底(`MUSEBOT_API` / `MUSEBOT_BASE_URL` / `MUSEBOT_MODEL` / `MUSEBOT_API_KEY`),`source` 字段告诉页面当前来源。
- `PUT /api/settings` 之后 `applyModel()`:用新配置重建 provider → `models.setProvider()` → 把每个 bot 会话 `configure({model})` 到新 id → 同时改写 `bot.agent.model`,这样运行时重建 group runtime 也是新模型。**在跑的任务不受影响**(它已经在用旧 model 生成),下一轮生效。
- 启动时先按环境变量把 harness 打开,再读设置文档;只有 `source === "settings"` 时才 `applyModel`(幂等、可回滚到 env)。
- `POST /api/settings/check` 是真探针:按协议拼 `${baseUrl}/models`、带对应鉴权头(openai-*: `Bearer`;anthropic: `x-api-key` + 版本头;google: `?key=`),8s 超时,返回 `ok/status/latencyMs/modelListed/models[0..8]`。不发 chat 请求,不烧 token。
- `GET /api/status` 现算:模式、端口(server 侧补)、uptime、db 路径、归档目录与文件数/字节、群/bot 数、版本。
- 密钥只以掩码 `sk-ma…bb9b` 出页面;写入时空值表示"沿用已存的那把",所以面板不需要回传明文。

### 5.7b 监听地址与远程访问

- `musebot.settings.host`(`127.0.0.1` 默认 / `0.0.0.0`)决定 HTTP+WS 绑哪块网卡;启动时 `main.ts` 从 `app.network()` 读它传给 `startServer({host})`,并在 `0.0.0.0` 时打印局域网 / tailnet 地址。**运行中不能改绑定**,所以 `PUT /api/network` 只落库并返回 `restartRequired: true`,面板据此提示重启。
- `GET /api/devices` = `app.network()`(`host/hosts/lan/tailscale`)+ server 侧事实(`bindHost/port/urls/clients`):
  - `lan`:`os.networkInterfaces()` 里的非 internal IPv4;
  - `tailscale`:`tailscale version` 判是否安装,`tailscale status --json` 取 `BackendState / Self.DNSName / Self.TailscaleIPs`,3s 超时,失败就是失败(不猜);
  - `urls` 只按**当前 bind** 生成,避免列出打不开的地址;
  - `clients`:WS 连接表,按 `ip+UA` 合并,含 `connectedAt / lastAt / connections`。
- 服务本身不启动/登录 Tailscale,只读它的状态;这点写在 UI 上。

#### 一键 tailnet 访问(`POST /api/tailscale/serve`)

- 前置:`tailscaleBin()` 依次找 `tailscale`(PATH)、macOS 应用包内 CLI、`/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin`;没装就直接报"没有装 Tailscale"。
- 开启:tailnet 有证书(`Self.CertDomains` 非空)→ `tailscale serve --bg --yes <port>`(发布到 443/HTTPS);没有证书 → `tailscale serve --bg --yes --http=<port> http://127.0.0.1:<port>`(HTTP 模式)。命令 20s 超时,超时/失败把 stderr 原文回给 UI,不假装成功。
- 关闭:`disableServe(port)` 先读 `serve status --json`,**只有当现有配置全部指向我们的端口**时才执行 `tailscale serve reset`;发现是别人的 serve 配置就拒绝并提示手动处理——一个按钮不该清掉用户的其它服务。
- 解析:`serve status --json` 的 `Web[host:port].Handlers["/"].Proxy` 折成 `{url, proxy, mode}`,`:443` 判为 https。

### 5.7c 群里的文件消息(`chat.file`)

- 上传落在 `data/uploads/<groupId>/<uuid>`,**原始文件名只作显示**,不参与路径;大小上限 12MB,空文件拒收。
- 条目 `{kind:"chat.file", data:{author, file:{id,name,mime,bytes}, at}}` 走同一个黑板 channel(`channel.attach`),所以群里照样不跑模型、不阻塞。
- 下载路由按 groupId 隔离,id 必须是 UUID 形状;跨群拿同一个 id 读不到。
- 前端三类渲染:图片 `<img>`、音频 `<audio>`、其它文件气泡下载;`previewOf` 会把 `[文件]/[图片]/[语音] 名字` 带到群列表摘要。
- 与 bot 交付物的区别:这是**人发的**,没有 artifact、不进归档、不做 markdown 预览。

### 5.7d IM 桥(通用中转)

- 配置文档 `musebot.im-bridge`,每群一份 `{token,enabled,callbackUrl,updatedAt}`;创建群后首次访问配置页自动 `ensure` 一个 token。
- 入站:`token` 在 URL 里(不依赖 cookie,方便企业微信机器人/脚本),校验后用 `router.route` 复用"像不像需求"的判断;`chat` 走 `send`,`requirement` 走 `api.requirement`。错误 token 403,停用 403,空文本 409。
- 出站:`outbox` 读群会话条目,`since` 是 entry id;只返回 `chat.message / chat.file / delivered`,不含内部 `planning/assigned/done`,避免把过程噪音转给外部 IM。
- 没有做主动推送回调:回调 URL 只存不用(明确写在页面上),避免假装有公网可达的 webhook。要推送时由中转服务轮询 outbox。

### 5.7e 自定义 bot 与个人资料

- 启动时 `createCustomBotStore(harness).load()` 先读 `musebot.bot-directory` + 每个 `musebot.custom-bot`,再和 `config/bots.ts` 的内置 bot 合并成同一个 `bots[]`;`createBotRegistry` 额外提供 `add()`,新建后立即进注册表、`/api/bots`、加成员候选和领导可派名单。
- `POST /api/bots` 的 `groupId` 非空时在同一请求里 `addMember`,建群/进群没有中间态;`botRegistry` 里 `custom:true` 的条目会显示「自定义」来源,内置与自定义 bot 的提示词/模型覆盖都按群保存,名字/头像都走全局 `bot-identity` 可写。
- `planner.plan` 现在只接收**本群实际成员**的 bot 列表,避免领导把任务派给不在群里的 bot(会永久 blocked)。
- 个人资料是单例 `musebot.user-profile`;头像在浏览器 canvas 里裁成 160×160 JPEG data URL(≤240KB)后才上传,不做图片文件落盘,也不新增静态路由。前端 `paintAvatar` 统一处理"图片或字符"两种头像,群拼图第一格也用同一份。
- bot 的名字/头像用单例 `musebot.bot-identity` 覆盖 `config/bots.ts` 或 `musebot.custom-bot` 的默认值;`updateBotProfile` 同时接受 `name/avatar`,更新后直接改 `botRegistry` 里的对象,所以群成员、群头像拼图、消息作者和领导 prompt 立即用新身份。
- `web/app.js` 的 `botListSection()` 把 `/api/bots` 和当前群 roster 交集画成群列表下方的可折叠「我的 bot」段;`openContactsPane()` 是独立的通讯录两栏窗口(列表/详情/管理),动作都走真实 API,不维护第二份本地 bot 表。

### 5.8 单个 bot 的覆盖:提示词与模型

- 文档 `musebot.bot-profile`,key 用 `groupId::botId`,字段 `instructions / model / updatedAt`;**空字段 = 用默认**,所以"恢复默认"就是写空串。
- `groupRuntime.configureBot()` 在每次 attach/open 时读覆盖并 `configure({model, instructions})`:`instructions = override || bot.agent.instructions`,`model = override ? {provider, modelId: override} : bot.agent.model`。
- 保存后调 `runtime.reconfigureBot(botId)`,立刻把新配置写进该群该 bot 的会话;正在跑的那一轮不受影响。
- 视图 `botProfile()` 只读拼装:身份来自 `botRegistry`,交付/资料库来自 `work-graph + artifact`,所在群来自 `groupStore`,记忆摘要来自 `musebot.memory`(`memory:{enabled,count}`,完整列表走专门接口)。例行任务/权限这些不存在的能力仍然不做,面板里就不出现。

### 5.9 交付物归档(scratch / archive 两级)

```
data/workspace/<botConversationId>/…            每次派单前 reset(scratch)
data/archive/<groupId>/<workItemId>/…           publish 时整体 copy 过来,永不删除
```

- `write_file` 只往 scratch 写;publish 阶段 `workspace.archive(groupId, workItemId, conversationId)` 把 scratch **整体复制**到 archive,再用 archive 的清单作为 `artifact.files`。
- 为什么必须复制:同一个 bot 的 scratch 目录会被它的**下一个**任务 `reset()` 清掉;不复制的话,上一单交付的文件在磁盘上就没了,只剩 artifact 里截断的 preview。
- 幂等:publish 重跑时先 `rm -rf` 目标目录再 copy,同一 workItem 只会有一份。
- 下载路由只服务 `artifact.files` 里列过的路径(`fileFor` 先查 artifact),archive 目录不是可浏览的目录服务;`safeRelativePath` + 归档根前缀双重校验,`../` 与绝对路径都拒。
- `archive` 默认在 workspace 同级(`data/archive`),可用 `MUSEBOT_ARCHIVE` / `opts.archiveRoot` 指到独立卷。
- **没有做保留期清理**:归档只增不减,要清理得外部定时任务(明确留白,不假装有)。

### 5.10 bot 长期记忆(抽取 → 存储 → 检索)

> 完整选型与社区对比见 [`MEMORY.md`](./MEMORY.md)。这里只记落地口径。

- **一条链路**:交付成功后 `WorkItemTask.publish` 通过 `deps.onDelivered` 调 `memoryExtractor.afterDelivery` 抽 0-3 条 → `memoryStore.add` 写 durable 文档 `musebot.memory`(`key = groupId::botId`)→ 该 bot 下次请求时 `memorySection` 按相关度取 top-K 注入 `<bot-memory>`。
- **存储**:`{groupId,botId,enabled,items:[{id,text,kind,source,at,score}]}`;每 (bot,群) 上限 50 条,超了淘汰 `score` 最低/最旧;重复(规范化相同或 token Jaccard ≥ 0.82)只强化不新增。零向量库、纯 SQLite 文档。
- **抽取**:规则优先——需求里含"记住/以后/偏好/口径/统一用…"的句子、交付正文里显式结论句;跳过一次性任务细节。可选 `deps.model` 钩子,离线/失败自动降级。全程 try/catch,**不影响交付状态**。
- **检索**:`memorySection` 用 `input.conversationId` 经 `groupStore.botIdForConversation` 反查 (bot,群);用当前请求(会话最新 `pi.user`)的 token 重叠 + 新近度打分,取 top-6、截断 ~2000 字符。只读、不触发 run。
- **API**:`GET/POST/DELETE/PUT /api/groups/:id/bots/:botId/memory[...]`;`botProfile()` 附 `memory:{enabled,count}` 摘要。
- **边界**:每 bot 每群一份、不跨群;关键词检索不做语义泛化;无版本历史与回滚。

## 6. 协议 Schema

```ts
// A1
type WorkStatus = "blocked"|"queued"|"running"|"delivered"|"done"|"failed"|"cancelled";
type WorkItem = {
  id; planId; key; groupId; subject; capability;
  assignee?; deps: string[]; status: WorkStatus;
  blockedReason?; artifactId?; taskId?;
};
type PlanItem = { key; subject; capability; deps: string[]; preferAssignee? };
type Plan = { id; groupId; requirement; items: PlanItem[] };
type Artifact = {
  id; workItemId; botId; kind: "text"|"file"|"diff"|"image";
  title; body?; ref?;
  files: { path: string; bytes: number; preview?: string }[];  // M3:write_file 的产出
};
type PinItem = { id; text; by; at: number };
type GroupPinDoc = { announcement: string; pins: PinItem[] };  // 全群 bot 共享上下文

// B6 —— 持久文档(全部 session scope)
type GroupDoc = {
  id; name; roster: string[]; rules; topic; createdAt;
  groupConversationId; orchConversationId;
  botConversations: Record<botId, conversationId>;   // 字符串存,用时 Number()
};
type WorkGraphDoc = { items: WorkItemRow[] };        // 每群一份
```

```ts
// A2 —— ev 折进 data,整体是合法 EntryDraft
type WorkEvent = { kind: "work.event"; data:
  | { ev:"planning"; by }                          // 已接需求,领导正在分工
  | { ev:"plan"; planId; groupId; by; items: PlanItem[] }
  | { ev:"assigned"; workId; botId; deps: WorkItemId[] }
  | { ev:"started"; workId; botId }
  | { ev:"blocked"; workId; reason }
  | { ev:"delivered"; workId; botId; artifact: Artifact }
  | { ev:"done"; workId; botId }
  | { ev:"failed"; workId; botId?; error }
  | { ev:"cancelled"; workId; reason? }
};
```

**只进群**:`chat.message` + `work.event`。**永不进群**:工具调用、推理、完整 transcript。

---

## 7. 关键时序

### 7.1 整体流程

```
人 → 发送("出季度财报") → chat():像请求 → 领导分工      ← 立即返回(实测 9ms)
                    └─ 不像请求 → 只落一条群消息
  → 群黑板: 真人消息 + planning 卡
  → planner(异步):领导会话拆任务 → JSON → validatePlan(失败回退固定四步)
  → scheduler.submitPlan:
       每项 createTask(WorkItemTask) [+ 依赖任务 id] → graph.syncPlan → plan 卡
  → 每个 WorkItemTask:
       wait_deps(allSettled) → dispatch(选本组空闲 bot / 全忙则睡一会儿再选)
       → bot 私有会话执行(带需求 + 上游交付;可调 write_file)
       → publish(回答文本 + 文件 → 交付卡 → 图状态 done)
  → 期间群不收 input,人随时可发言/派新活/取消单项
```

### 7.2 WorkItemTask 的 phase(派发与完成)

```ts
// wait_deps
await rt.commit(() => ({
  status: "waiting",
  on: depTaskIds,
  policy: "allSettled",              // 不用 failFast:避免一个失败中止兄弟任务
  checkpoint: { phase: "dispatch" },
}), ctx);

// dispatch:只在本组空闲成员里挑人;全忙则睡一会儿再挑
const botId = await group.activity.chooseIdle(item.capability, ctx);
if (!botId) {
  await rt.commit(async (tx) => {
    if (!cp.blockedNotified) {
      await tx.appendEntry(group.groupConversationId, { kind: "work.event",
        data: { ev: "blocked", workId, reason: "no idle bot" } });
      await group.graph.transition(tx, groupId, workId, "blocked", { blockedReason: "no idle bot" });
    }
    return { status: "sleeping", until: rt.now() + retryMs,
             checkpoint: { phase: "dispatch", blockedNotified: true } };
  }, ctx);
  return;
}

// 清空该 bot 的交付目录,再把需求 + 任务 + 上游交付喂给它
await group.workspace.reset(conv.id);
const content = await composePrompt(task, group, ctx);   // requirement / subject / 上游文件与正文
await conv.submit({
  type: "input",
  content,
  requestId: `work:${workItemId}`,                        // 幂等:重跑不重复派活
  notify: { taskId: rt.taskId, key: "answer" },           // notify 在 draft 里
}, ctx);
await rt.commit(async (tx) => {
  await tx.appendEntry(group.groupConversationId, assignedCard(wi));
  await tx.appendEntry(group.groupConversationId, startedCard(wi));
  await group.graph.transition(tx, groupId, workId, "running", { assignee: botId });
  return { status: "sleeping", signals: [SubmissionSettled.key("answer")],
           checkpoint: { phase: "publish", botId } };
}, ctx);

// publish:真实回答 + 工作区文件 → 交付卡;失败 → 失败卡
const settled = await rt.readSignal(SubmissionSettled, "answer", ctx);
const answer = await readAnswer(conv, ctx);
const files = await group.workspace.list(conv.id);
const artifactId = await group.artifacts.put({ workItemId, botId, title, body: answer, files }, ctx);
await rt.commit(async (tx) => {
  await tx.appendEntry(group.groupConversationId, deliveredCard(wi, artifact));
  await tx.appendEntry(group.groupConversationId, doneCard(...));
  await group.graph.transition(tx, groupId, workId, "delivered", { artifactId });
  await group.graph.transition(tx, groupId, workId, "done", {});
  return { status: "terminal", outcome: { status: "completed", result: { artifactId } } };
}, ctx);
```

> `Conversation.submit(draft, ctx)` 第二参是 **Context**;`notify` / `requestId` 是 **draft 字段**。
> **abort phase** 写 `cancelled` 卡 + 图状态 `cancelled`;取消时调度器还会 `conv.abort()` 停掉那个 bot。

### 7.3 bot 忙 → 排队 → 自动重派(无 signal 依赖)

- **忙判**:`activity.isBusy(botId)` 读该 bot 会话的 `LiveDoc.run`;不在本组名册里的 bot 一律不可选。
- **无空闲**:落 `blocked(no idle bot)` 卡(每轮只写一次),`sleeping{until}` 自轮询,醒来重新 `chooseIdle`。
- **为什么不用 signal**:pi-durable 的 signal key 一次性,常驻 dispatcher 反复睡同一个 key 会抛错;自轮询完全不碰 signal,durable 且简单。
- **重启**:WorkItemTask 是 durable,`harness.resume()` 后继续;忙闲由 LiveDoc 重建,无需内存表。

### 7.4 群公告 / 群置顶 = 全群共享上下文

- 存成 `GroupPinDoc{announcement, pins[]}`,按群一个文档。
- 通过 **prompt section**(D2)在**每次请求前**渲染进该群每个 bot 的 system prompt(`<group-context>…</group-context>`);bot 每条会话按 (bot, group) 绑定,section 用 `input.read` 读文档、用 `input.conversationId` 反查 groupId。
- **更新公告只改文档**,不触发 run、不进群会话、不破坏"群永不 input";下次请求自动生效。
- 渲染有上限(默认 2k tokens),超长截断并在群内提示;它只做共享上下文,不替代交付物协作。

---

## 8. 目录结构

```
bot/
  data/             musebot.sqlite(默认库)+ workspace/<conversation>/ 交付文件
  docs/{DESIGN.md, API.md, README.md, *.jpg}
  src/
    protocol/       { types.ts, events.ts, plan.ts }
    state/          { harness.ts, botRegistry.ts, groupStore.ts, workGraph.ts, botActivity.ts, memoryStore.ts, docs.ts }
    orchestration/  { router.ts, planner.ts, scheduler.ts, dispatcher.ts }
    execution/      { workItemTask.ts, groupContext.ts, memorySection.ts, memoryExtractor.ts, groupRuntime.ts, workspace.ts, fileTool.ts }
    publish/        { groupChannel.ts, workCards.ts, artifacts.ts, answer.ts }
    server/         { httpWs.ts, streamBridge.ts }
    config/         { bots.ts, model.ts }
    app.ts           (组合根:多群 + 取消/成员/分页/只读 + 记忆)
    main.ts          (env 装配 + HTTP/WS;静态托管 webui/dist,缺省回退 web/)
  web/              { index.html, app.js }      零构建旧客户端(回退)
  webui/            Vue3 + Vite;构建产物 dist/ 由服务端静态托管
  test/             { m1, m2, features, real.smoke }
```

---
## 9. 实现范围(按里程碑)

| 里程碑 | 范围 | 验收脚本 |
|---|---|---|
| M1 | 群黑板 + WorkItemTask + bot 单线程忙闲 + 工作卡 | `npm run m1:accept` |
| M2 | SQLite 持久化 + 多群 + 每群独立 bot 会话 | `npm run m2:accept` |
| M2.5 | 真模型 + 真实交付文本 + 超时/重试 | `npm run real:smoke` |
| M2.6 | 领导真分工(结构化 Plan) | `real:smoke` 打印 subjects |
| M3 | 取消 / 成员增删 / 分页 / 真工具 / 多进程 | `npm run features:accept` + 双进程手测 |
| M3.6 | 个人资料 / 自定义 bot / 通讯录两栏 / 我的 bot 段 / 文件上传下载归档 / IM 桥 / 设置与网络 | `features:accept` + `ui:check` + `ui:composer` |

**暂不做**:Jev 路由、鉴权、多写进程、telemetry。

---

## 10. 技术栈与运行

- Node 22(`22.22.2`)+ TypeScript ESM,`node --experimental-strip-types`。
- pi-durable(本地源码版)、pi-ai(OpenAI-compatible provider)、`ws`。
- SQLite 持久化(WAL,`synchronous = NORMAL`);单写进程 + 可选只读查看进程。

```bash
cd bot
npm run m1            # http://127.0.0.1:18800,真实网关
MUSEBOT_FAUX=1 npm run m1   # 离线 faux
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `18800` | HTTP/WS 端口 |
| `MUSEBOT_DB` | `<bot>/data/musebot.sqlite` | `:memory:` 可跑纯内存 |
| `MUSEBOT_BASE_URL` | `http://192.168.1.149:3425/v1` | 网关地址 |
| `MUSEBOT_API_KEY` | 内置本地 key | 网关 key |
| `MUSEBOT_MODEL` | `workbuddy/deepseek-v4.1-flash` | 模型 id |
| `MUSEBOT_FAUX` | — | `1` 回到离线 faux |
| `MUSEBOT_DELAY` | `0` | 仅 faux 生效的模拟耗时 |
| `MUSEBOT_RETRY` | `500` | 无空闲 bot 时的重派间隔 ms |
| `MUSEBOT_READONLY` | — | `1` 只读查看进程(写接口 403) |
| `MUSEBOT_GROUP_POLL` | 只读时 `3000` | 跨进程群列表轮询间隔 ms |

---

## 11. 失败模式 / 边界

| 情形 | 处理 |
|---|---|
| bot 忙 | `chooseIdle` 只在本组空闲成员里改派;全忙则 `blocked(no idle bot)` 卡 + `sleeping{until}` 自轮询重派 |
| 任务崩溃 | durable task 从 checkpoint 续跑;`kill -9` 实测重启后补齐,`requestId` 保证不重复交付 |
| 模型卡住 | `stream.timeoutMs=120s` + `retry{maxRetries:2}`;仍失败 → `failed` 卡(reason),bot 释放 |
| 结算非 done | `SubmissionSettled.status === "unanswered"` → `failed` 卡(带 reason),任务 terminal |
| 依赖环 | `validatePlan` 拒绝并写 `blocked` 卡;领导输出非法能力/前向引用 → 丢弃该条,仍非法则回退固定四步 |
| 取消 | abort phase 写 `cancelled` 卡 + 图状态;同时 `conv.abort()` 停 bot;下游依赖失败 → `failed` 卡 |
| 移除忙的 bot | `removeMember` 返回 409(`bot busy`),先取消再移 |
| 看板/卡片不一致 | 状态迁移与 `tx.appendEntry` 写进**同一 commit** |
| 群公告过大 | section 渲染上限 8k 字符(约 2k tokens),超出截断 |
| 公告更新 | 只改文档、不触发 run;下次请求自动生效 |
| WS 断线 | 前端指数退避重连并带当前群 id;连上后服务端整页重推 |
| 只读进程 | 写接口一律 403;历史/群列表可读,群列表靠轮询 |

---

## 12. 明确假设

1. **单写进程**部署;只读查看进程可以多开。多写需要外部协调(未做)。
2. 一个 bot 在**一个群内**单线程;跨群并行(不同群是不同会话)。
3. 领导是 bot,输出结构化 Plan;规则/提示词负责质量,不做项目级规划(排期/预算)。
4. 交付物 = 模型文本 + 它在工作区写的文件;群只看到成品,不看推理与工具调用。
5. **群会话永不 `input`**;管家发言也是 `write`。
6. 群公告/群置顶是该群所有 bot 的共享上下文,由 section 每次请求前渲染,不写进永久 instructions。
7. 成员变化只改名册与会话挂载;**已跑的任务不迁移**(移除 busy 的 bot 会被拒)。
8. 不 fork MausBot / Multica;Jev 路由明确推迟。

---

## 13. 里程碑(全部已交付)

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 不卡会话 demo(群黑板 + WorkItemTask + 忙闲) | ✅ |
| M2 | SQLite 持久化 + 多群 + 每群独立 bot 会话 | ✅ |
| M2.5 | 真模型 + 真实交付 + 超时/重试 | ✅ |
| M2.6 | 领导真分工(结构化 Plan) | ✅ |
| M3 | 取消 / 成员增删 / 分页 / 真工具 / 多进程只读 | ✅ |
| M3.5 | Web UI 微信化(三栏 + 交互) | ✅ |
| M3.6 | 个人资料 / 自定义 bot / 通讯录两栏 / 我的 bot 段 / 文件上传下载归档 / IM 桥 / 设置与网络 | ✅ |
| v2(未启动) | Jev 路由、鉴权、多写进程、telemetry | ⬜ |

---

## 14. 审查清单(已全部通过)

- [x] 模块 A–H / B–F 划分
- [x] WorkItem 状态机与工作卡(含 `cancelled`)
- [x] "群 = 黑板(永不 input)"
- [x] 群公告/置顶注入位置(section)与上限
- [x] 每群独立 bot 会话、单写多读部署模型
- [x] 真模型/真工具下的交付物边界
- [x] 个人资料 / 自定义 bot / bot 身份的重启持久化
- [x] 通讯录是 bot 地址簿,不伪装好友/朋友圈
- [x] 文件上传、下载、归档与 IM 桥的真实边界

---

## 15. 修订记录

**v1.9(M3.6:交互收口 / 个人资料 / 自定义 bot / 通讯录 / 文件归档 / IM 桥)**
- 新增 `musebot.user-profile`、`musebot.bot-directory`、`musebot.custom-bot`、`musebot.bot-identity`;内置与自定义 bot 均可改全局名字/头像,重启保留。
- 新增个人资料、新建 bot、通讯录两栏窗口、群列表下方可折叠「我的 bot」段、微信式 `N个置顶聊天` 行;bot 设置里的「工具」与「Skill」明确分开。
- 新增文件上传/下载/归档、群公告/置顶 UI、IM 通用 Webhook、设置热切换、局域网/tailnet 访问。
- 测试:`features:accept` 覆盖 profile/create bot/identity/IM/uploads/settings/network;`ui:check` + `ui:composer` 覆盖新 UI。

**v1.8(M3:取消 / 成员 / 分页 / 真工具 / 多进程)**
- 见 §5.4;新增 `npm run features:accept`,工作区 `data/workspace/<conversation>/`,`MUSEBOT_READONLY=1` 只读查看进程。
- 前端:取消按钮、加载更早、交付文件列表(名称/大小/预览);成员增删暂时只有 API。

**v1.7(领导真分工)**
- `planner` 改为调用群内领导会话,输出结构化 Plan;提示词承载全部规则;解析失败回退固定四步。
- `requirement()` 变异步:需求先落群消息 + `planning` 卡,再让领导分工,HTTP 立即返回。
- 前端新增 `planning` 卡样式。**仍不启用 Jev**。

**v1.6(真模型)**
- 新增 §5.2:自建 `musebot` OpenAI-compatible provider;交付物改为模型真实回答;任务提示词带上游交付;请求超时 + 重试;`MUSEBOT_FAUX=1` 回离线。
- **不含 Jev**:路由/规划仍是规则 + 脚本。
- 新增 `npm run real:smoke`(真网关跑一个计划,断言交付物有真实文本)。

**v1.5(M2:SQLite 持久化 + 多群)**
- 新增 §5.1:5 个 session 文档、建群单 commit、会话 id 落盘复用、每群独立 bot 会话、图与卡片同 commit、artifact 幂等 id。
- `groupStore` / `workGraph` / `artifacts` 从内存投影改为持久文档;新增 `state/docs.ts`、`execution/groupRuntime.ts`。
- `app.ts` 改为多群:`ensureGroup / listGroups / readItems(groupId) / watchGroup / watchGroups`;`workItemTask` 通过 `input.groupId` 解析 runtime。
- server: `GET/POST /api/groups`、`GET /api/groups/:id/items`、`POST /api/groups/:id/{send,requirements}`、`WS /stream?g=<id>`。
- 默认库 `<bot>/data/musebot.sqlite`;新增 `npm run m2:accept`(两群并发 + 重启断言)。

**v1.4(M1 实现对齐)**
- 唤醒改为 **WorkItemTask 自轮询**(`sleeping{until}`),不再用常驻 signal dispatcher;C4 留 M2。
- M1 的 `groupStore` / `workGraph` 用内存投影(接口不变),doc 持久化留 M2;`D2` 用 section 闭包读群配置,不触发 run。
- 群频道只 `write`;WorkItemTask 用 `tx.appendEntry` 在**同一 commit** 写状态卡。
- WS:连接后推 `{type:"state", items}`;每次 commit 重推;HTTP 提供 `/send` `/requirements` 与静态 `web/`。

**v1.3(YG 审查补充)**
- 新增"群公告 / 群置顶 = 全群 bot 共享上下文":`GroupPinDoc` + `D2 groupContext.ts` 的 prompt section;只读文档渲染,不触发 run,不破坏"群永不 input"。

**v1.2(第二轮复核后)**
1. **[BLOCKER] 去掉 signal 常驻唤醒**:pi-durable signal key 一次性,改为**一次性 DispatchTask + `sleepUntil` 轮询 + `DispatchDoc` 去重**。删除 `protocol/signals.ts`。
2. **派发契约**:删除阻塞式 `BotWorker.run()`,改为 `WorkItemTask` 的 `wait_deps → dispatch → publish` 三 phase。
3. **幂等**:`submit({requestId: "work:<id>"})`;`addPlan` 按 `plan.id` 幂等。
4. **忙闲**:不再自建 lease/BotStateDoc,直接读 `LiveDoc.run`;消除"永久占用"。
5. **Dispatcher 单例**:`DispatchDoc{taskId}` 去重;`background: true`。
6. **publish 分支**:处理 `unanswered` → failed 卡;checkpoint 存 `botId/submissionId`。
7. **依赖策略**:`policy:"allSettled"` + `runtime.outcomes()` 检查,避免 `failFast` 误杀兄弟任务。
8. **归属**:WorkItemTask 用独立编排会话(ownerless),群会话只写卡;避免组 abort 级联。
9. **同 commit**:状态迁移 + 卡片 `tx.appendEntry` 一次提交。
10. 修 `API.md`:notify 在 draft、第二参 Context、defineDocFamily 必备字段、signal key 一次性。

**v1.1** 修 4 个 BLOCKER(lease/notify 宿主/delivered 卡/Context)+ 多项 MAJOR。

**v1.0** 初版(plan mode 批准)。

---

## 16. 结项状态(v1.9 / M3.6)

### 16.1 已实现并通过验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 群黑板 + WorkItemTask 三阶段 + bot 单线程忙闲 + 工作卡 | `m1:accept`:两次派单 7ms/3ms,8/8 交付 |
| M2 | SQLite 持久化 + 多群 + 每群独立 bot 会话 | `m2:accept`:两群并发 9ms,重启后群/会话/工作图/置顶等价 |
| M2.5 | 真模型 + 交付物为真实回答 + 上游交付入提示 + 超时/重试 | `real:smoke`:4/4 done,交付含真实文件 |
| M2.6 | 领导真分工(结构化 Plan,解析失败回退) | 真实网关拆出 4 级财报链 / 2 条并行;`requirement` 9ms 返回 |
| M3 | 取消 / 成员增删 / 分页 / `write_file` 工具 / 单写多读 | `features:accept` + 浏览器 E2E + 双进程手测 |
| M3.5 | Web UI 对齐微信桌面端(三栏 / 时间行 / 未读 / 置顶 / 搜索 / 卡片消息化) | `WEBUI.md` §6 + 两轮评审 |
| M3.6 | 个人资料 / 自定义 bot / 通讯录两栏 / 我的 bot 段 / 文件上传下载归档 / IM 桥 / 设置与网络 | `features:accept` + `ui:check` + `ui:composer` |

崩溃恢复:`kill -9` 后任务续跑、无重复交付(`requestId` 幂等 + durable task)。

### 16.2 明确的设计边界(不是缺陷)

- 群会话永不产生 run;不存在"群卡住"的路径。
- 执行细节(推理/工具/长文)不进群;群里只有交付卡里的成品文本与文件。
- 一个 bot 在**一个群内**单线程;跨群并行。
- 持久化粒度是群、置顶、工作图、交付物、个人资料、自定义 bot 与 bot 身份等小文档。
- 多进程是**单写多读**:只读进程可以多开,写进程只有一个。
- 通讯录是 **bot 地址簿**,不是微信好友/朋友圈;没有对应能力的入口不做。

### 16.3 还没做(按性质分类)

**产品功能**
- 归档没有自动清理策略,需要按磁盘配额外部处理。
- 取消只能逐个任务,没有批量取消。
- 没有多选/转发、群二维码、朋友圈、收藏等未实现的微信入口。
- IM 只提供通用 Webhook/outbox 中转,**不直接连**微信或企业微信服务器(需要企业主体、公网回调与验签)。

**平台能力**
- 多写进程(需要外部选主或 DB 锁协调)。
- telemetry / 结构化日志。
- 鉴权与移动端原生打包(当前是浏览器访问 + 局域网/tailnet)。

**明确推迟**
- **Jev 分类器**:路由仍是正则规则。
- **规划质量**:领导偏爱串行/假依赖,**留给后续 skill**,不再堆提示词。
- **Skill 配置**:当前只有 `write_file` 工具;可复用 Skill/流程包尚未接入。

### 16.4 v1 收口口径

1. 群任意时刻可发言、可派单(满足);
2. 交付能点开看到真实成品,可预览、下载、归档(满足);
3. 重启不丢群、历史、进行中的活(满足);
4. 领导按需求换分工(满足,质量待 skill);
5. 单个任务可取消,成员可增删,历史可翻页,个人资料/自定义 bot/通讯录可用(满足)。

前四条构成 v1;第 5 条及 IM/文件归档属于 v1.x,当前均已交付。
