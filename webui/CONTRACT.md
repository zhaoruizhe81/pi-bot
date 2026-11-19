# musebot Web UI（Vue 3 重构）协作契约

> 目标：把 `bot/web/`（零构建、原生 DOM，`index.html` + `app.js`，~5000 行）重构为 `bot/webui/`（Vue 3 + Vite）。**界面与交互必须与旧版完全一致**——旧 `web/index.html` 的 `<style>` 已原样复制到 `webui/src/styles/app.css`（1686 行，禁止改动其中任何选择器/变量/数值）。新代码只允许复用这些 class，不得另造视觉风格。
>
> 旧实现是唯一规格来源：`bot/web/app.js` 与 `bot/web/index.html`。每个组件的行为、DOM 类名、文案都应从旧代码对应函数搬过来，不要重新设计。旧 `web/` 保留不动，作为对照与回退。

## 0. 运行 / 构建

- 开发：`cd bot/webui && npm run dev`（5199，代理 `/api` `/stream` 到 `MUSEBOT_DEV_TARGET`，默认 `http://127.0.0.1:18800`）
- 构建：`cd bot/webui && npm run build` → `webui/dist/`；服务端从 `webui/dist` 静态托管。
- 技术栈：Vue 3 `<script setup>` + Composition API，纯 JS（非 TS），不使用 Pinia/vue-router（单页，状态用 `reactive` 单例）。

## 1. 文件归属（避免多人同时改同一文件）

| 归属 | 文件 |
|---|---|
| 契约/store（A） | `src/store.js`, `src/lib/ui.js`, `src/lib/markdown.js`, `src/lib/api.js` |
| 外壳/群列表（A） | `src/App.vue`, `src/components/Rail.vue`, `src/components/GroupList.vue`, `src/components/GroupAvatar.vue`, `src/components/Avatar.vue`, `src/components/Icon.vue`, `src/components/NewGroupForm.vue` |
| 聊天区（B） | `src/components/ChatView.vue`, `src/components/MessageStream.vue`, `src/components/Composer.vue`, `src/components/FileBubble.vue`, `src/components/FilePreview.vue`, `src/components/EmojiPanel.vue`, `src/components/MarkdownView.vue` |
| 面板（C） | `src/components/InfoPane.vue`, `src/components/MemberPicker.vue`, `src/components/ContactsPane.vue`, `src/components/BotPane.vue`, `src/components/BotCreator.vue`, `src/components/Sheet.vue` |
| 设置（D） | `src/components/SettingsDialog.vue` + `src/components/settings/*.vue` |
| 后端记忆（E） | `bot/src/**`（见单独任务） |
| 入口 | `src/main.js`（仅 A 改） |

每个组件只写自己归属的文件；需要新增共用小组件先在自己文件里内联，或联系 lead。

## 2. store 契约（`src/store.js`）

导出：

```js
import { reactive, computed } from "vue";
export const state = reactive({ ... });        // 全局唯一响应式状态
export const actions = { ... };                 // 所有数据动作（见下）
export function boot();                         // 应用启动：加载 profile/bots/groups、连 WS、按 hash 选群
export const ui = { ... };                      // 纯函数格式化助手（实际在 lib/ui.js，store 里 re-export）
```

`store.js` 必须 `export` 一个 `useMusebot()` 便捷函数，返回 `{ state, actions, ui }`，方便组件：

```js
const { state, actions, ui } = useMusebot();
```

### 2.1 state 形状（全部用普通对象/数组，便于模板）

```js
state = {
  // 群
  groups: [],              // {id,name,roster,createdAt,last}
  groupsLoaded: false,
  groupId: null,
  items: [],               // 当前群 entries，oldest→newest，元素 {id,kind,data}
  next: null,              // 加载更早的 cursor
  connected: false,
  // 详情缓存（群信息边栏用）
  detailByGroup: {},       // gid -> {group,members,announcement,pins}
  // bot
  bots: [],                // /api/bots
  botCapabilities: [],
  // 列表/搜索
  search: "",              // 群列表搜索词
  msgSearch: "",           // 当前群消息搜索词
  filterCount: 0,
  // 本地个人偏好（localStorage）
  profile: { name: "我", signature: "", avatar: "", updatedAt: 0 },
  nick: "",                // mb.nick 当前群昵称（legacy 是单值；保留单值行为）
  mute: {},                // gid -> true   (mb.mute 是数组，这里映射成对象)
  remark: {},              // gid -> string (mb.remark 是对象)
  pinsCollapsed: false,    // mb.pins.collapsed
  botsCollapsed: false,    // mb.botsCollapsed
  // 面板开合
  infoOpen: false, infoEdit: null, infoQuery: "",
  contactsOpen: false, contactsQuery: "", contactsSelected: null, contactsManage: false,
  pickerOpen: false, pickerQuery: "", pickerPicked: [],   // 已选 botId 数组
  settingsOpen: false, settingsPage: "ai", settingsQuery: "", settingsAdv: false,
  settingsConfig: null, settingsStatus: null, settingsCheck: null,
  devices: null, im: null, imToken: "",
  botOpen: false, botId: null, botProfile: null, botAcc: "overview", botQuery: "",
  // 浮层
  toast: null,             // {text, at}
  menu: null,              // {x,y,items:[{label,run,danger,disabled}]}
  filePreview: null,       // {file, artifact, workId, source, preview, loading}
  sheet: null,             // {title, sections:[...]}（旧 openSheet 的替代）
  // 运行时
  busyBots: [],            // 当前群忙碌 botId 数组
  pending: [],             // 乐观发送 {tmpId,text}
}
```

### 2.2 actions（方法名固定，组件按此调用）

```js
// 生命周期
boot()
connect()                     // WS；内部指数退避
refreshGroups()
selectGroup(gid)              // 切换群：保存/恢复滚动与草稿由组件负责，store 负责拉 items+connect
loadEarlier()
loadDetail(gid, force=false)
saveRead(gid, lastId)

// 发送
send(text)                    // 旧 submitText：单输入框，chat 判定
retryPending(tmpId)
sendFileNow(file, isImage)    // 上传一个 File -> chat.file
uploadAvatar(file)            // 裁 160x160 -> dataURL
createGroup(name)

// 工作
cancelWork(workId)

// 群信息写
renameGroup(gid, name)
setAnnouncement(gid, text)
addPin(gid, text)
removePin(gid, pinId)
addMember(gid, botId)
removeMember(gid, botId)
addMembers(gid, botIds[])     // 串行，逐个提示失败

// bot
openBot(gid, botId)
loadBotProfile(gid, botId)
saveBotProfile(patch)         // {name?,avatar?,instructions?,model?}
createBot(payload)            // {name,capability,instructions,avatar,groupId}
// 记忆（后端 E 提供；前端 E/F 用）
loadMemory(gid, botId)
addMemory(gid, botId, text)
deleteMemory(gid, botId, memId)
toggleMemory(gid, botId, enabled)

// 设置
openSettings(page)
loadSettingsData()
saveSettings(payload)
checkSettings()
loadDevices()
applyNetwork(host)
toggleServe(enabled)
loadIm(gid)
rotateIm(gid)
updateIm(gid, patch)
exportGroup(gid, format)

// 通用
toast(text, ms)
openMenuAt(x, y, items)
closeMenu()
closeAll()                    // Esc：关闭 menu/sheet/toast/filePreview/info/bot/contacts/settings
```

所有写动作失败时 `toast(err.message)`，不抛到组件（组件可 `await` 后再判断；约定：成功返回结果，失败返回 `undefined` 且已 toast）。

### 2.3 格式化助手（`src/lib/ui.js`）

必须与旧版逐字一致的纯函数（从 `app.js` 搬）：

`str, hashColor, firstChar, pad2, hhmm, timeLabel(ts), tsOf(entry), needsTime(prevTs,ts), shortId(id), workKeyOf(data), subjectOf(data), formatSize(bytes), displayName(group), botName(id), botAvatar(id), botMeta(id), memberName(id), memberNameByCapability(cap), summaryOfLast(last), previewOf(entry), unreadOf(gid), nickName(), isMuted(gid), remarkOf(gid)`

颜色常量：`AVATAR_COLORS`, `BOT_META` 默认（leader/finance/data/analysis/design）, `EV_META`, `EV_PREVIEW`, `EMOJIS`, `SHORTCUTS`, `GROUP_GRID`。

### 2.4 markdown（`src/lib/markdown.js`）

把旧 `renderMarkdown(source)` 改为返回 **Vue VNode/HTML-safe 结构**：为避免 v-html XSS，用 `renderMarkdownNodes(source)` 返回可渲染的节点数组（`{type:'h1'|'p'|'table'|'pre'|'ul'|...}`），或返回 `{ html }` 但 html 必须由 `textContent` 逻辑构造后转义（禁止直接 innerHTML 原文）。至少支持：标题、粗斜体、行内码、链接、代码块、表格、引用、有序/无序列表、分隔线。组件 `MarkdownView.vue` 负责渲染。

## 3. 组件对应关系（旧函数 → 新组件）

- `renderGroups/groupRow/botListSection/updateRailBadge/renderRailAvatar` → `Rail.vue` + `GroupList.vue` + `GroupAvatar.vue`
- `renderHeader` → `ChatView.vue` 头部
- `renderStreamFull/renderChatEntry/renderMessage/renderWorkEvent/renderFileMessage/timeRow/appendWithMentions/cancelButton/fileBubble` → `MessageStream.vue` + `FileBubble.vue`
- `renderTextInto`（@提及高亮）→ 组件内 computed 分段
- `submitText/file/image/voice/emoji` → `Composer.vue` + `EmojiPanel.vue`
- `openInfoPane/renderInfoPane/infoRow/infoSwitch/infoEditor` → `InfoPane.vue`
- `openMemberPicker/renderPicker/submitPicker` → `MemberPicker.vue`
- `openContactsPane/renderContactsPane/renderContactDetail` → `ContactsPane.vue`
- `openBotPane/renderBotPane/botSectionBody/saveBotProfile` → `BotPane.vue`（并新增「记忆」分区）
- `openBotCreator` → `BotCreator.vue`
- `openSettings/renderSettings*` → `SettingsDialog.vue` + `settings/*`
- `openFileSheet/renderMarkdown` → `FilePreview.vue` + `MarkdownView.vue`
- `openSheet/sheetSection/rowAction` → `Sheet.vue`
- `openMenuAt/toast` → `App.vue` 内的全局浮层

## 4. DOM/类名

组件模板必须产出与旧 DOM 相同的 class 结构（`app/rail/list/chat/stream/composer/info-pane/bot-pane/settings/picker/contacts-window/sheet/menu/toast/overlay` 等），因为 CSS 依赖它们。根节点使用 `<div class="app" :data-view="...">`，`data-view` 在移动端为 `list`/`chat`（旧 `setView`）。

## 5. 验收

- `npm run build` 成功，`dist/index.html` 可被服务端加载。
- 离线 demo：`MUSEBOT_FAUX=1 MUSEBOT_DB=/tmp/mb-vue/m.db PORT=18860 npm run m1` + `BASE=http://127.0.0.1:18860 npm run demo:seed`；截图与旧 `docs/webui-*.jpg` 视觉一致。
- `node test/ui.panel.mjs` / `ui.composer.mjs` 的交互（选择器基于 class/id）应继续通过；若选择器需微调，记录在任务里。
