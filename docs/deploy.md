# 部署指南(新机器 / 新环境)

把 musebot(含 bili 上下文压缩层)部署到一台新机器的完整步骤。整个项目是自包含的:**`repo/`(pi 源码)+ `bot/`(musebot)必须一起拷贝**——bot 的依赖是 `file:../repo/packages/*` 相对引用。

## 前置要求

- Node.js ≥ 22(用了实验性 `node:sqlite`)
- macOS 或 Linux(bili 的软链/证书路径按 mac/linux 写;Windows 未验证)
- 一个 OpenAI 兼容模型网关(任意 host,部署时才知道地址;见第 4 步)

## 1. 拷贝项目 + 安装依赖

```bash
# 把整个 pi/ 目录(repo/ + bot/)拷到目标机,然后:
cd pi/bot
npm install          # file: 依赖会链接 ../repo/packages/*
npm run web:build    # 构建前端到 webui/dist
```

## 2. 安装 bili(上下文压缩代理)

```bash
npm install -g billion-context --prefix=~/.local   # bili 命令落在 ~/.local/bin
```

## 3. 写 bili 生产配置(命名配置,不污染全局)

`~/.config/billion-context/musebot.json`:

```json
{
  "port": 18790,
  "host": "127.0.0.1",
  "log": true,
  "network": { "allowPrivateHttpProviders": true },
  "providers": {
    "<你的网关地址,例如 http://192.168.1.149:3425>": {
      "models": { "<模型 id>": { "context": 200000, "output": 8192 } }
    }
  },
  "compress": {
    "maxContextLimit": "75%",
    "nudgeGrowthTokens": 3000,
    "minPressureBenefitTokens": 0,
    "injectNudge": true
  }
}
```

要点:
- `providers` 的 key 是**上游网关 URL 前缀**(部署时改成真实地址);网关在私网/纯 HTTP 上必须开 `network.allowPrivateHttpProviders`
- `context` 声明该模型真实窗口;**不要声明得比会话不可约下限还小**(系统提示词 ~6K 不可折叠,窗口必须远大于它),否则 bili 会 fail-fast 413 拒绝转发
- `nudgeGrowthTokens` 默认 50000 是为"月级超长会话"调的,musebot 规模用 3000
- 启动:`nohup bili start -c musebot > /tmp/bili-prod.log 2>&1 &`,面板在 `http://127.0.0.1:18790`

## 4. 启动 musebot 并把网关指到 bili

```bash
cd pi/bot
PORT=18800 nohup npm run m1 > /tmp/musebot.log 2>&1 &
```

两种方式把网关切到 bili(选一):

- **设置页(推荐,持久化)**:打开 Web UI → 设置 → AI 模型,把 Base URL 改成
  `http://127.0.0.1:18790/bili/<你的网关地址>/v1`(注意 `/bili/` 后面跟**完整上游 URL**),保存即热切换;写入数据库,重启后仍生效
- **环境变量**:`MUSEBOT_BASE_URL=http://127.0.0.1:18790/bili/<网关>/v1 npm run m1`

API Key / 模型 id 沿用原来的;`MUSEBOT_DB` / `MUSEBOT_ARCHIVE` / `MUSEBOT_UPLOADS` 可把数据目录挪到自定义位置。

## 5. 验证

```bash
curl http://127.0.0.1:<port>/api/skills          # 技能目录非空
curl -X POST http://127.0.0.1:<port>/api/dm/leader/open   # 私聊群创建
# 群里发一条消息,bot 回复即链路通;
# bili 面板 http://127.0.0.1:18790 能看到对应会话(pfa-* 前缀亲和)
```

About 页(设置 → 关于)应有「上下文压缩:billion-context」署名(bili 的 license 条款要求,勿删)。

## 数据与状态一览

| 内容 | 位置 |
|---|---|
| musebot 会话/群/bot | `MUSEBOT_DB`(默认 `bot/data/musebot.sqlite`) |
| 交付归档 / 上传 | `bot/data/archive`、`bot/data/uploads`(可用 MUSEBOT_ARCHIVE/UPLOADS 覆盖) |
| bili 压缩账本 | `~/.local/share/billion-context/sessions/`(持久,勿随意删) |
| bili 配置 | `~/.config/billion-context/musebot.json` |

## 已知行为(非故障)

- 网关不可达 / 负载超过声明窗口时,bili 会 fail-fast 413 拒绝转发,bot 回复「这轮没有完成(model_error: …)」——错误原因里带明细,优先检查 bili 配置的 `context` 与网关连通性
- bili 的 `nudgeGrowthTokens` 调小后压缩频繁属正常(日志可见 `Compressed … saved`);想省事调回 50000 即回到"月级会话才压"的姿态
- 旧私聊会话里 bot 可能重复它历史上说过的话(上下文记忆),开新私聊即可
