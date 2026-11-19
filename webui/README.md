# musebot Web UI（Vue 3 重构）

`bot/web/`（零构建 `index.html` + `app.js`，约 5000 行命令式 DOM）已用 **Vue 3 + Vite** 重写到本目录。
**界面与交互保持与旧版一致**：旧 `web/index.html` 的 1686 行 `<style>` 原样复制为 `src/styles/app.css`，
组件模板产出与旧版相同的 DOM 结构与 class/id；旧 `web/` 保留作对照与 `dist` 缺失时的服务端回退。

## 运行 / 构建

```bash
cd bot/webui
npm install
npm run dev      # http://127.0.0.1:5199，/api 与 /stream 代理到 MUSEBOT_DEV_TARGET(默认 18800)
npm run build    # 产物 dist/，服务端从 webui/dist 静态托管
```

在 `bot/` 下也可用 `npm run web:dev` / `npm run web:build`。

## 结构

```
src/
  main.js                 挂载
  App.vue                 三栏外壳(.app)、rail/list/chat、全局 menu/toast/overlay
  store.js                reactive 单例 state + actions + boot()（WS/API/localStorage 全在这）
  lib/
    ui.js                 旧 app.js 的常量与纯格式化函数（avatar/time/preview/unread…）
    markdown.js           安全的 markdown -> 节点数组渲染
    api.js                fetchJson/postJson/apiWrite
  components/
    Rail, GroupList, GroupAvatar, Avatar, Icon, NewGroupForm        左栏
    ChatView, MessageStream, Composer, FileBubble, FilePreview,
      EmojiPanel, MarkdownView                                      聊天区
    InfoPane, MemberPicker, ContactsPane, BotPane, BotCreator, Sheet 右侧面板/浮层
    SettingsDialog + settings/*                                     设置 8 页
  styles/app.css          旧 index.html 的样式，逐字复用（禁止改）
```

`CONTRACT.md` 是多人协作时冻结的 store/组件接口契约。

## 与后端

- 完全复用既有 HTTP/WS 契约（见 `docs/DESIGN.md §5.6`），未改任何字段语义。
- 服务端把 `<bot>/webui/dist` 作为静态目录：`/`→`index.html`、`/assets/*`→文件、未知 GET 回退 SPA，
  并防目录穿越；`dist` 不存在时回退旧 `web/`。
- **bot 记忆**：新增 `GET/POST/PUT/DELETE /api/groups/:id/bots/:botId/memory`；`BotPane` 的「记忆」分区
  可查看/新增/删除/开关。后端由 `src/state/memoryStore.ts` + `memorySection.ts` + `memoryExtractor.ts`
  实现（抽取→存储→检索，参考 mem0/Letta，详见 `docs/MEMORY.md`）。

## 验证

```bash
cd bot
npm run web:build
node test/ui.panel.mjs      # 群信息/成员/通讯录/bot 抽屉/设置/新建 bot/头像（Vue 版全过）
node test/ui.composer.mjs   # 表情/文件/图片/语音/通讯录（Vue 版全过）
npm run m1:accept && npm run m2:accept && npm run features:accept
```

离线演示：`MUSEBOT_FAUX=1 MUSEBOT_DB=/tmp/mb-vue/m.db PORT=18860 npm run m1`，另开终端
`BASE=http://127.0.0.1:18860 npm run demo:seed`，浏览器打开 `http://127.0.0.1:18860`。
