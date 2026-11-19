# pi-durable API 参考(本地源码版 · 含 signals)

> 本文档由 `bot/node_modules/@earendil-works/pi-durable` 的**实际产物** `dist/**/*.d.ts` 抽取生成,不是照 README 复述。
> 来源:本地 monorepo 源码构建(`repo/packages/durable`,版本串 1.5.2 + 未发布的 signals)。
> `bot` 通过 `file:` symlink 指向 `repo/packages/durable`,**改源码后需 `cd repo/packages/durable && npm run build` 才生效**。
> 所有签名以 `repo/packages/durable/dist/harness/types.d.ts`、`dist/types.d.ts`、`dist/signals.d.ts` 为准。

---

## 0. 心智模型(先记这 8 个词)

| 概念 | 含义 |
|---|---|
| **Harness** | 一个打开的存储 + 跑 agent 的机器。所有改动走同一条原子提交线,先提交后展示。 |
| **Conversation** | 一段 transcript(不可变 entry 序列)。`root()` 建根会话,可 `createConversation()` / `fork()`。 |
| **Entry** | 不可变记录:`pi.user` / `pi.assistant` / `pi.tool-result` / `pi.system` / `pi.reset` / 自定义 kind。 |
| **Commit** | 一次原子写:append entry + 改 document + 建 task,要么全成要么全不成。 |
| **Document** | 和 transcript 一起存的类型化 JSON 状态(`pi.agent` / `pi.live` / `pi.inbox` / `pi.usage` / `pi.provider`)。 |
| **Task** | 持久状态机,每阶段存 checkpoint;重启从断点续跑。 |
| **Submission** | 交给会话的一次输入,可 `wait()`。 |
| **Signal** | 从外部(webhook / 人工)投递给挂起 task 的类型化 JSON 值。 |

一次被回答的输入:

```
submit(input) → pi.user
  pi.generation → pi.system(仅当 prompt/tools 变了), pi.assistant(可能带 tool call)
    pi.tool × n → pi.tool-result × n        (由 generation 拥有并等待)
  pi.generation → pi.assistant(最终答案) → submission done
```

所有 `context: Context` 参数都来自 `@earendil-works/chord/context`,最常用 `BACKGROUND_CONTEXT`(永不取消、NOOP span)。

---

## 1. 导入路径总表

```ts
import { Harness, createRegistry, defineExtension, defineTool, defineTask, defineDoc,
         defineSignal, section, hook, hookTask, LiveDoc, InboxDoc, ... } from "@earendil-works/pi-durable";
import { CodingTools, createBashTool, ... } from "@earendil-works/pi-durable/tools";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
```

| 子路径 | 内容 | 运行环境 |
|---|---|---|
| `.` | 主入口(见 §2–§9) | Node/浏览器 |
| `/tools` | `read/write/edit/bash/powershell` + `CodingTools` | Node |
| `/codemode` | 模型写 JS 沙箱调工具 | Node/CF |
| `/tool-search` | 大工具集检索(deferred tools) | Node |
| `/env` `/env/node` | 执行环境基元 / `NodeExecutionEnv` | Node |
| `/images` `/images/node` | 图像处理(Photon WASM) | Node/CF |
| `/storage/*` | 各存储后端(见 §8) | 见各节 |
| `/testing` | 存储/环境一致性测试工具 | Node |

---

## 2. `Harness`(运行时核心)

运行时是对象,**唯一静态方法 `Harness.open(storage, options, ctx)`** → `Promise<Harness>`。
`HarnessOptions` 关键字段:`models`(必需,`Models` 或 `()=>Models`)、`registry`(必需)、`telemetry?` `identity?` `settings?` `env?` `now?` `setTimer?` `onWake?` `conversationCreated?`。

**实例方法**(durable 调用都要 `context`;`resume()` / `wake()` 无 `context`):

| 方法 | 作用 |
|---|---|
| `resume(): void` | 开启任务调度(幂等)。`submit`/`wait`/`waitForTask`/`waitForIdle` 也会隐式开启。 |
| `wake(): Wake` | 给 serverless 宿主:`{ active: boolean; at?: number }`(最早 sleep 时间)。 |
| `root(ctx, { agent?, init? })` | 取/建保留的根会话。 |
| `conversation(id, ctx)` | 按 id 取会话(不存在返回 `undefined`)。 |
| `createConversation(opts, ctx)` | 新建会话,`opts: { ownership, agent?, init? }`。 |
| `getTask(id, ctx)` | 取任务记录。 |
| `inspect(ctx)` | 活任务 + 未结提交 + 阻塞诊断(不写、不跑代码)。 |
| `submission(id, ctx)` / `abortSubmission(id, ctx, convId?)` | 重取/中止提交。 |
| `abortTask(id, ctx)` | 中止任务(提交中止标记并调度 abort 阶段)。 |
| `signal(taskId, token, key, value, ctx)` | ★ 投递信号给任务 → `SignalResult`。 |
| `waitForTask(id, ctx)` | 等任务终态 → `SettledTask`。 |
| `waitForIdle(ctx)` | 等所有 ownerless 会话无活跃非后台任务。 |
| `usage(ctx)` | 全 Session token/花费汇总。 |
| `watchTaskGraph(ctx)` | 整个任务树视图(Chord `WatchHandle`)。 |
| `observeConversation(id, obs, ctx, window?)` / `observeTaskGraph(obs, ctx)` | 同步观察者(低层)。 |
| `commit(fn(tx), ctx, opts?)` | Session 级原子提交。 |

---

## 3. `Conversation`(会话句柄)

| 方法 | 作用 |
|---|---|
| `id` | 只读句柄标识。 |
| `agent(ctx)` | 解析出当前有效 agent(model/extensions/tools/sections/cwd)。 |
| `configure(change: AgentChange, ctx)` | 改会话 agent 配置(见 §3.3)。 |
| `submit(draft, ctx) → Submission` | ★ 准入输入 / 被动写 / continue(见 §3.2)。 |
| `submit(tx, draft) → SubmissionId` | 在你自己 commit 内准入;须在首个表写之前调用。 |
| `reset(handoff?, ctx)` | 开新上下文(`pi.reset`),旧 entry 保留。 |
| `compact(instructions?, ctx) → TaskId` | 手动压缩,返回压缩任务 id。 |
| `commit(fn(tx), ctx, opts?)` | 原子提交,`tx.createTask()` 默认归属本会话。 |
| `context(ctx, { at? })` | 模型实际看到的 active transcript。 |
| `entries(query, limit, cursor, ctx)` | 分页读 entry。 |
| `fork(at: EntryId, opts, ctx) → Conversation` | 从某条 entry 分叉。 |
| `abort(ctx, opts?)` | 中止当前工作。 |
| `waitForIdle(ctx)` | 等本会话空闲。 |
| `watch(ctx, window?) → ConversationWatch` | ★ 结构化视图 + 每次 commit(含流式 partial),给前端/IM 推。 |

### 3.2 `SubmissionDraft` 形态

```ts
type SubmissionDraft = { requestId?: string } & (
  | { type: "input"; content: UserInput;
      whenBusy?: "steer" | "followUp" | "reject";   // steer=插当前轮后;followUp=答完后下一轮;reject=忙则抛 ConversationBusy
      whenIdle?: "reject";                          // 空闲则抛 ConversationIdle,绝不自己起 run
      entry?: { kind: string; data?: JsonValue } }   // 以自定义 entry 呈现(kind 不能以 "pi." 开头)
  | { type: "write"; entry: EntryDraft }             // 只追加 entry,不问模型(仅 kind+data 时即时落)
  | { type: "continue" }                             // 不输入消息,让停掉的 run 继续答(仅空闲)
);
```

### 3.3 `AgentChange`(`configure` 的入参)

```ts
{
  model?: ModelRef | null;                 thinkingLevel?: ModelThinkingLevel | null;
  extensions?: Extension[] | { add?: Extension[]; remove?: Extension[] } | null;
  tools?: ToolRegistration[] | { remove: ToolRegistration[] } | null;
  modelTools?: ToolRegistration[] | { remove?: ...; add?: ... } | null;  // 只收窄给模型看的,不夺走 tools
  instructions?: string | null;
  cwd?: string | null;
  maxTurns?: number | null;                // 一次 run 最多几轮工具调用(≥1 或 null)
  compaction?: CompactionSettings | null;
}
```
未设字段跟随 host 默认;`null` 清回默认。

---

## 4. `Submission`

| 成员 | 作用 |
|---|---|
| `id` | 标识。 |
| `status(ctx)` | `SubmissionRecord`(`queued` / `placed` / `done` / `unanswered`)。 |
| `wait(ctx)` | `SettledSubmissionRecord`(只剩 `done` / `unanswered`;`unanswered` 带 `reason`/`detail`)。 |
| `abort(ctx)` | `"aborted" \| "already_placed" \| "settled"`。 |

---

## 5. 定义 API(写扩展 / 工具 / 任务 / 文档 / 信号)

| 函数 | 用途 / 关键字段 |
|---|---|
| `defineExtension(ext)` | `{ name, namespace?, tools?, sections?, hooks?, wraps?, tasks? }`。name 唯一。 |
| `defineTool(tool)` | `{ name, description, parameters(schema), execute(args, api, ctx), callers?, replay?, executionMode?, prepareArguments?, structuredOutputSchema?, deferred?, outputLimits?, cancel? }`。 |
| `defineTask(def)` | `{ name, version, initial(input)→state, phases: { [phase]: handler }, abort(handler), migrate?, hooks? }`。 |
| `defineDoc(def)` | 自定义文档:`CommonDocDefinition`(kind/version/initial/checkpointWhen)+ `scope: "session" \| "task" \| "conversation"`;`scope:"conversation"` 再加 `history: "latest" \| "rewindable"` 与 `fork: "current" \| "initial"`。 |
| `defineDocFamily(def)` | 文档族(按 key 实例化);必需 `scope`、`family: true`、`kind`、`version`、`initial(seed)`、`checkpointWhen`。 |
| `defineEntry(def)` | 自定义 entry 类型。 |
| `defineSignal(def)` | 见 §7。 |
| `section(key, render, opts?)` | system prompt 段落;`render(input)` 可读 `input.env`/agent/已提交值,`{ tag:false }` 去包裹。 |
| `hook(task, handlers)` | 挂到 `GenerationTask`/`ToolTask` 等(见 §6.3 与 hook 表)。 |
| `hookTask(task, input)` | 在 hook 里声明"要跑的子任务"。 |
| `wrapTool(tool, w)` / `wrapSection(key, w)` | 给工具/段落套装饰器。 |
| `configure(tx, convId, change)` | **commit 内**的 configure 版本。 |
| `createRegistry()` | 建扩展注册表(`install/uninstall/installed/extension/tools/sections/tasks/task`)。 |
| `registryReader(...)` | 只读注册表视图。 |
| `createSession(...)` | 低层 Session(不做 agent 编排)。 |

`TaskDefinition` 的 phase handler 签名:
```ts
phase(task: RunningTask<I,S,R>, runtime: TaskRuntime<I,S,R,H>, ctx) => Promise<void>
```
返回下一个状态用 `runtime.commit(() => nextState, ctx)`,`nextState` 可为:
`{ status:"sleeping", signals?: SignalKey[], until?: number, checkpoint: S }`、
`{ status:"waiting", on: TaskId[], policy:"allSettled"|"failFast"|"any", checkpoint }`、
`{ status:"terminal", outcome: { status:"completed"|"failed"|"aborted", result? } }`。

---

## 6. 扩展运行时对象(传给回调的 `api` / `runtime`)

### 6.1 `ToolExecutionApi`(`tool.execute(args, api, ctx)` 第二参)

| 成员 | 作用 |
|---|---|
| `taskId` `conversationId` `callId` `registry` | 上下文标识。 |
| `wake` / `checkpoint` | 工具 park 被唤醒的原因 / 上次 park 存入的 checkpoint。 |
| `agent(ctx)` `models` `env` `now()` | agent / 模型 / 执行环境 / 时钟。 |
| `output(chunk)` `outputWindow` `retainedOutput()` | 流式输出与保留窗口。 |
| `diagnostic(d)` / `details(value, ctx)` | 结构化诊断 / 详情。 |
| `executeTool(name, args, ctx, { key?, progress?, wait? })` | ★ 嵌套调用另一个工具(结果不污染 transcript,可重放)。 |
| `conversation(id, ctx)` | 取被拥有会话句柄。 |
| `memo(name, …)` / `commit(fn)` / `createTask(…)` / `readSignal(…)` | 幂等键 / 子提交 / 子任务 / 读信号。 |

**park(工具挂起等外部事件)**:`execute` 返回 `{ sleep: { signals?, until?, checkpoint? } }` 或 `{ wait: { on, policy, checkpoint? } }`;唤醒后 `execute` 用同一参数重跑,`api.wake` 说明原因、`api.checkpoint` 接续;`cancel(args, api, ctx)` 在挂起被停止时清理。

### 6.2 `TaskRuntime`(`defineTask` phase 第二参)

| 成员 | 作用 |
|---|---|
| `commit(fn(tx, current)→nextState, ctx)` | ★ 提交下一状态(checkpoint/terminal/sleeping/waiting)。 |
| `memo(name, …)` | 幂等/记忆值。 |
| `sleepUntil(until, checkpoint, ctx)` | 睡到某时刻。 |
| `readSignal(token, key, ctx)` | 读信号 key 状态(`{value}` / `{expired}` / `undefined`)。 |
| `getTask(id)` / `waitForTask(id)` / `ownedTasks()` / `outcomes(ids)` / `abortOwned(id)` | 子任务读取/等待/结果。 |
| `conversation(id, ctx)` / `entry` / `entries` | 会话与历史。 |
| `agent(ctx)` `env(ctx)` `now()` `setTimer(cb, ms)` `report(err, from?)` | 运行时设施。 |

### 6.3 `HookApi`(hook 回调第二参)

`taskId` `conversationId` `models` `memo` `readSignal` `now()` `entry/entries` `snapshot()`(读已提交文档)。

**内置 hook 点**:`GenerationTask`:`beforeRequest` `beforeProviderRequest` `afterResponse` `onYield` `afterTools` `afterRun`;`ToolTask`:`beforeTool`(可 `{block}` / 改写参数 / `{sleep}` 挂起等审批)`afterTool`(可替换结果)。

---

## 7. Signals API(本地源码版新增)

```ts
// 定义一种信号
const Answer = defineSignal({
  name: "app.answer",          // 唯一,不含 "/"
  version: 1,                  // 正整数
  schema: obj({ text: str() }),// pi-schema,值类型 = Static<schema>
  migrate?(value, fromVersion) // 旧版本值升级
});
// SignalToken<T> = { name, version, key(key: string): SignalKey<T> }

// 三处使用:
await root.commit((tx) => tx.createTask(AskPerson, input, { ownership: { kind: "conversation" } }), ctx); // 建任务
const r = await harness.signal(taskId, Answer, "answer", { text: "Yes" }, ctx); // 宿主投递 → "delivered"
// 任务阶段里:
const state = await runtime.readSignal(Answer, "answer", ctx); // {value:{text}} | {expired:true} | undefined
```

- `SignalResult = "delivered" | "duplicate" | "invalid" | "closed" | "not_found"`。
- `SignalState<T> = { value: T } | { expired: true }`。
- **早到的信号会保留**,睡眠立即醒;**signal key 是一次性的**:被某次 wake 消费过的 key 不能再被 sleep 引用(`checkSleep` 抛错),同一 key 重复投递恒为 `duplicate`;大对象请传引用(id)。
- `SubmissionSettled`:内建信号。**`notify` 是 draft 的字段,`submit` 第二参是 `Context`**:`submit({ type:"input", content, notify:{ taskId, key } }, ctx)`。结算时把 settle 记录投递给该 task,让子任务在提交结算时收到通知——这是"工具等子 agent 而不占进程"的机制。
- **自定义 task 必须通过 `defineExtension({ tasks: [...] })` 注册进 registry**,否则任务卡在 `missing_task`。

---

## 8. 内建 token / 常量

| 类别 | 名称 |
|---|---|
| 文档 | `AgentDoc` `LiveDoc` `InboxDoc` `UsageDoc` `ProviderDoc` `NestedCallDoc` |
| Entry | `UserEntry` `AssistantEntry` `SystemEntry` `ToolResultEntry` `CompactionEntry` `ResetEntry` |
| 任务 | `GenerationTask` `ToolTask` `CompactionTask` |
| 常量 | `ROOT_CONVERSATION_ID` `DEFAULT_HARNESS_IDENTITY` `DEFAULT_COMPACTION_POLICY` `DEFAULT_PROGRESS_POLICY` `DEFAULT_RESTART_LIMIT` `DEFAULT_RETRY_POLICY` `DURABLE_TELEMETRY_SCHEMA` `SubmissionSettled` |
| `ConversationTranscript` | 客户端 transcript 窗口/断线重连/加载更早(实现 bot 前端很省事) |

---

## 9. 存储后端

| 后端 | 导入 | 说明 |
|---|---|---|
| Memory | `MemoryStorage`(根) | 不持久,测试用。 |
| IndexedDB | `IndexedDbStorage.open(name)` @ `/storage/indexeddb` | 浏览器。 |
| SQLite(Node) | `openNodeSqliteStorage(file)` @ `/storage/sqlite/node` | WAL,崩溃可恢复。★生产常驻首选。 |
| JSONL(Node) | `openNodeJsonlStorage(dir, ctx)` @ `/storage/jsonl/node` | 追加文件;长跑建议 SQLite。 |
| Store | `StoreStorage` @ `/storage/store` | 挂到 Chord host store(共享提交队列/ID)。 |
| Cloudflare DO | `openDurableObjectSqliteStorage(ctx.storage)` @ `/storage/sqlite/cloudflare` | 一个 DO = 一个会话状态;配 `onWake`。 |

低层:`openNodeSqliteDatabase` / `NodeSqliteDatabase` / `DurableObjectSqliteDatabase` / `SqliteStorage.open(db,{prefix})` / `applySqliteMigrations`。

---

## 10. 错误类型(可 `instanceof`)

`ConversationBusy` `ConversationIdle` `ReadAfterWrite` `ReadOnlySession` `SessionFailed` `StorageRequestError`;JSONL:`JsonlCorruptionError` `JsonlStoragePoisonedError` `JsonlStorageReadOnlyError`。

---

## 11. 其他配置类型速查

- **`HarnessOptions`**:`models` `registry`(必需);`telemetry` `identity` `settings` `env` `now` `setTimer` `onWake` `conversationCreated`。
- **`Settings`**(Harness 级):`extensions` `stream` `retry` `compaction` `progress` `toolExecution` `steeringMode` `followUpMode` `contextRetentionMs` `documentRetentionMs` `afterFailedRun` `restartLimit`。
- **`TaskOptions`**:`ownership`(必需:`{kind:"conversation"}` / `{kind:"task",taskId}`)、`conversationId?` `background?` `abandonOnRestart?` `trace?` `links?`。
- **`CommitOptions`**:`{ persistence?: { kind:"deferred", withinMs? } }`(易丢的进度可先展示后落盘)。
- **`ConversationCreateOptions`**:`{ ownership, agent?, init? }`。

---

## 12. 起步骨架(bot/src 可跑)

| 文件 | 演示 |
|---|---|
| [src/smoke.mjs](../src/smoke.mjs) | 最小闭环:open → root → submit → assistant entry → entries(faux 模型,离线)。 |
| [src/signals-smoke.mjs](../src/signals-smoke.mjs) | signals 全链路:defineSignal → 任务 sleep → `harness.signal` 投递 → 唤醒 → 完成。 |

运行:
```bash
cd bot
npm run smoke           # SMOKE OK
npm run smoke:signals    # SIGNALS SMOKE OK  (result "Yes")
```

一个典型 bot 后端骨架(伪结构):
```
平台 webhook ─▶ chord/http(fetch handler, 验签)
                 │ 按 用户/频道 → harness.conversation(id) 或 createConversation
                 ▼
          conversation.submit({type:"input", content, whenBusy, entry:{kind:"chat.message",data}})
                 │
   conversation.watch() ─▶ 发送适配器 ─▶ 回推 IM
                 │
  需要等回调/审批 → defineSignal + 工具 park / defineTask sleep → harness.signal 唤醒
```

---

## 13. 维护规则

1. 改 `pi-durable` 源码后:`cd repo/packages/durable && npm run build`(bot 是 symlink,重建即生效)。
2. 别 `git clean -xfd` 清 `repo/`:`dist/` 与 `ai/src/providers/data/*.json`(hydrate 下载)会被清掉,需重跑 `hydrate-model-data` + 整链构建。
3. API 标 **Experimental**,会随版本变;升级前跑 §12 的 smoke 回归。

---

## 14. 本项目实现中确认的约束(v1.8 补充)

以下是写 musebot 时**实测**得到的 pi-durable 行为,与官方文档字面容易踩偏,记下来防复发。

### 14.1 ID 是 number

`ConversationId` / `TaskId` 都是 **number**。`harness.conversation("3")` 永远返回 `undefined`,`harness.abortTask("82")` 会抛 `Task 82 does not exist`。
持久化到 JSON 文档里只能存 string,读出来调用前必须 `Number()`。

### 14.2 draft 里 push 进去的普通对象不被追踪

```ts
const doc = await tx.doc(Graph, gid, null);
doc.items.push({ id, taskId: "" });   // 普通对象
doc.items.at(-1).taskId = "42";       // 不会落盘
```

`tx.doc()` 返回的是**代理**;通过 `push` 加进去的裸对象不在代理里,之后的赋值不会进 delta。
正确做法:构造完整对象后一次 `push`;或者先 `push` 空对象,之后只通过 `doc.items[i].x = …` 改(索引访问经过代理)。

### 14.3 工具必须由 extension 装进 registry

`configure({ tools: [myTool] })` 只是**过滤器**,不是注册。未装 registry 时:

- `conversation.agent()` 的 `tools` 为空;
- 模型看不到工具,会自己编 native 标记(例如 `<||DSML||>…`),表现为"假装调用了工具";
- 症状:交付物里出现原始标记,文件一个都没写。

正确做法:

```ts
registry.install(defineExtension({ name: "my-tools", tools: [myTool] }));
```

### 14.4 `readOnly` 与"跨进程"

- `Harness.open(storage, { readOnly: true })`:不恢复任务、不写、`resume()` 会抛 `ReadOnlySession`。
- 文档读有缓存(`settings.documentRetentionMs`,默认 10 分钟);**只读查看进程要设 0**,否则看不到另一个进程的提交。
- `watchDoc()` 只观测**本进程**的提交;跨进程只能轮询(本项目:3s)。
- 一个 SQLite 文件只能有一个写进程,多个读进程可以同时开。

### 14.5 请求级超时/重试

`Harness.open(..., { settings })`:

```ts
settings: {
  stream: { timeoutMs: 120_000 },                       // 网关静默卡死时结束该次尝试
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
}
```

网关"连接已建立但 `bytes_in` 不再增长"是真实会发生的;没有超时,任务会永久占住那个 bot。

### 14.6 `submission.wait()` 与幂等

同一 `requestId` 重复 `submit` 返回同一个 submission(已在队列/已结算都不会重跑),这是崩溃恢复不重复交付的关键;不要自己在业务层生成随机 requestId。
