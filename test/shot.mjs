// Headless-Chrome screenshot helper for the Web UI docs (no deps beyond ws + local Chrome).
// Usage: node test/shot.mjs <baseUrl> <outDir>
import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const BASE = process.argv[2] ?? "http://127.0.0.1:18860";
const OUT = process.argv[3] ?? path.join(import.meta.dirname, "..", "docs");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(OUT, { recursive: true });
const profile = path.join(process.env.TMPDIR ?? "/tmp", "mb-shot-profile");
await rm(profile, { recursive: true, force: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const waitJson = async (url, tries = 100) => {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`chrome did not answer: ${url}`);
};

const version = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

let seq = 0;
const pending = new Map();
const events = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method) events.push(msg.method);
});

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

// One page to drive everything.
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const call = (method, params) => send(method, params, sessionId);

await call("Page.enable");
await call("Runtime.enable");

const evaluate = async (expression, awaitPromise = true) => {
  const res = await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  return res.result?.value;
};

const viewport = async (width, height, mobile) => {
  await call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
  if (mobile) {
    await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await call("Emulation.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
  } else {
    await call("Emulation.setTouchEmulationEnabled", { enabled: false });
    await call("Emulation.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    });
  }
};

const shoot = async (name) => {
  const { data } = await call("Page.captureScreenshot", { format: "jpeg", quality: 88, captureBeyondViewport: false });
  const file = path.join(OUT, name);
  await writeFile(file, Buffer.from(data, "base64"));
  console.log("saved", file);
};

const openMenu = () => evaluate("document.getElementById('moreBtn').click(), true");
const clickMenu = (label) =>
  evaluate(
    `(() => { const b = [...document.querySelectorAll('#menu button')].find((x) => x.textContent.trim() === ${JSON.stringify(
      label,
    )}); if (!b) return false; b.click(); return true; })()`,
  );

await viewport(1280, 830, false);
await call("Page.navigate", { url: `${BASE}/?desktop=1#g=g1` });
await sleep(2500);

// 1) 点「…」→ 右侧群信息面板(仿微信桌面端)
await openMenu();
await sleep(700);
await shoot("webui-info.jpg");

// 1b) 面板里就地改群公告(证明写接口通)
await evaluate(
  `(() => { const row = [...document.querySelectorAll('#infoPane .info-row')].find((r) => (r.querySelector('.info-label') || {}).textContent === '群公告'); if (!row) return false; row.click(); return true; })()`,
);
await sleep(500);
await shoot("webui-info-edit.jpg");
console.log(
  "announcement save:",
  await evaluate(
    `(() => { const box = document.querySelector('#infoPane .info-edit'); if (!box) return 'no editor'; const area = box.querySelector('textarea'); area.value = ${JSON.stringify(
      "本周对外口径:统一用 Q3 财报(合并抵消后、未审计,收入 12,480 万)。过程稿不发群,只发成品。",
    )}; const ok = [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存'); ok.click(); return 'saved'; })()`,
  ),
);
await sleep(1400);

// 1c) 群置顶 / 成员菜单
await evaluate(
  `(() => { const row = [...document.querySelectorAll('#infoPane .info-row')].find((r) => (r.querySelector('.info-label') || {}).textContent === '群置顶'); if (!row) return false; row.click(); return true; })()`,
);
await sleep(500);
await shoot("webui-info-pins.jpg");
await evaluate(
  `(() => { const row = [...document.querySelectorAll('#infoPane .info-row')].find((r) => (r.querySelector('.info-label') || {}).textContent === '群置顶'); if (row) row.click(); return true; })()`,
);
await sleep(300);

// 1d) 添加成员弹窗(左右两栏,照微信)
const pageGroup = process.env.MB_SHOT_GROUP ?? "g1";
console.log(
  "free a slot:",
  await evaluate(`fetch('/api/groups/${pageGroup}/members/design', { method: 'DELETE' }).then((r) => r.ok)`),
);
await evaluate("document.getElementById('moreBtn').click(), true");
await sleep(400);
await evaluate("document.getElementById('moreBtn').click(), true");
await sleep(700);
await evaluate(
  `(() => { const b = document.querySelector('#infoPane .info-member.add'); if (!b) return false; b.click(); return true; })()`,
);
await sleep(800);
await evaluate(
  `(() => { const row = [...document.querySelectorAll('#picker .pick-row')].find((r) => r.textContent.includes('设计bot')); if (!row) return false; row.click(); return true; })()`,
);
await sleep(400);
await shoot("webui-info-add.jpg");
await evaluate("document.getElementById('pickerCancel').click(), true");
await sleep(300);
console.log(
  "restore member:",
  await evaluate(
    `fetch('/api/groups/${pageGroup}/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId: 'design' }) }).then((r) => r.ok)`,
  ),
);

// 1e) 单个 bot 的设置抽屉
await evaluate(
  `(() => { const p = document.getElementById('infoPane'); if (p.hidden) document.getElementById('moreBtn').click(); return true; })()`,
);
await sleep(600);
console.log(
  "open bot:",
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('#infoPane .info-member')].find((x) => x.textContent.includes('设计')); if (!b) return 'missing'; b.click(); return 'ok'; })()`,
  ),
);
await sleep(1400);
await shoot("webui-bot.jpg");
await evaluate("document.getElementById('botPane').querySelector('.info-close').click(), true");
await sleep(300);
await evaluate(
  `(() => { const p = document.getElementById('infoPane'); if (!p.hidden) document.getElementById('moreBtn').click(); return true; })()`,
);
await sleep(300);

// 2) 交付文件:md 渲染预览 + 原文
await evaluate("document.getElementById('moreBtn').click(), true");
await sleep(300);
console.log(
  "file bubble:",
  await evaluate(
    `(() => { const b = [...document.querySelectorAll('.file-bubble')].find((x) => x.textContent.includes(${JSON.stringify(
      process.env.MB_SHOT_FILE ?? ".md",
    )})); if (!b) return 'missing'; b.scrollIntoView({ block: 'center' }); b.click(); return b.textContent.trim().slice(0, 40); })()`,
  ),
);
await sleep(1200);
await shoot("webui-file-preview.jpg");
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#sheetBody .row-action')].find((x) => x.textContent.trim() === '原文'); if (!b) return false; b.click(); return true; })()`,
);
await sleep(400);
await shoot("webui-file-raw.jpg");

// 2d) 设置:AI 模型页(带检查结果)+ 运行状态页
await evaluate("document.getElementById('sheetClose').click(), true");
await sleep(300);
await evaluate("(() => { const p = document.getElementById('infoPane'); if (p && !p.hidden) document.getElementById('moreBtn').click(); return true; })()");
await sleep(300);
await evaluate("document.getElementById('railSettings').click(), true");
await sleep(900);
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#settings .settings-row button')].find((x) => x.textContent.trim() === '设置'); if (b) b.click(); return true; })()`,
);
await sleep(500);
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#settings button')].find((x) => x.textContent.trim() === '重新检查'); if (b) b.click(); return true; })()`,
);
await sleep(1600);
await shoot("webui-settings.jpg");
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#settingsNav .settings-nav-item')].find((x) => x.textContent.includes('运行状态')); if (b) b.click(); return true; })()`,
);
await sleep(700);
await shoot("webui-settings-status.jpg");
await evaluate("document.getElementById('settingsClose').click(), true");
await sleep(300);

// 2e) 个人资料页(头像 / 昵称 / 签名)
await evaluate("document.getElementById('railMe').click(), true");
await sleep(800);
await shoot("webui-profile.jpg");
await evaluate("document.getElementById('settingsClose').click(), true");
await sleep(300);

// 2f) 新建 bot 弹窗(+ 菜单 → 新建 bot)
await evaluate("document.getElementById('newGroupBtn').click(), true");
await sleep(400);
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#menu button')].find((x) => x.textContent.trim() === '新建 bot'); if (!b) return false; b.click(); return true; })()`,
);
await sleep(600);
await shoot("webui-bot-create.jpg");
await evaluate("document.getElementById('sheetClose').click(), true");
await sleep(300);

// 3) 手机尺寸:面板整屏
await evaluate("document.getElementById('sheetClose').click(), true");
await sleep(200);
await viewport(390, 844, true);
const MOBILE_GROUP = process.env.MB_SHOT_GROUP ?? "g1";
await call("Page.navigate", { url: `${BASE}/?mobile=1#g=${MOBILE_GROUP}` });
await sleep(2200);
await openMenu();
await sleep(700);
await shoot("webui-info-mobile.jpg");
await evaluate(
  `fetch('/api/groups/${MOBILE_GROUP}/members/design', { method: 'DELETE' }).then((r) => r.ok)`,
);
await evaluate("document.getElementById('infoPane').hidden = true, true");
await sleep(200);
await evaluate("document.getElementById('moreBtn').click(), true");
await sleep(500);
await evaluate(
  `(() => { const b = document.querySelector('#infoPane .info-member.add'); if (!b) return false; b.click(); return true; })()`,
);
await sleep(700);
await evaluate(
  `(() => { const row = [...document.querySelectorAll('#picker .pick-row')].find((r) => r.textContent.includes('设计bot')); if (!row) return false; row.click(); return true; })()`,
);
await sleep(300);
await shoot("webui-info-add-mobile.jpg");
await evaluate("document.getElementById('pickerCancel').click(), true");
await sleep(200);
console.log(
  "restore member (mobile):",
  await evaluate(
    `fetch('/api/groups/${MOBILE_GROUP}/members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId: 'design' }) }).then((r) => r.ok)`,
  ),
);

ws.close();
chrome.kill();
await sleep(200);
process.exit(0);
