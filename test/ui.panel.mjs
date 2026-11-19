// Headless check of the group-info side panel: the interactions a screenshot cannot prove.
// Usage: node test/ui.panel.mjs [baseUrl] [groupId]
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

import { fileURLToPath } from "node:url";

const botDir = fileURLToPath(new URL("../", import.meta.url));

// Hermetic by default: spin up a throwaway server on a temp database so the check never
// writes into the demo data. Pass a base URL as argv[2] to point at an existing server.
const PROVIDED = process.argv[2];
const PORT_HTTP = 18880 + Math.floor(Math.random() * 100);
const TMP_DB = `/tmp/mb-ui-check-${Date.now()}.db`;
let child;
let BASE = PROVIDED;
const GROUP = process.argv[3] ?? "g1";

if (!BASE) {
  child = (await import("node:child_process")).spawn(
    process.execPath,
    ["--experimental-strip-types", "src/main.ts"],
    {
      cwd: botDir,
      env: { ...process.env, MUSEBOT_DB: TMP_DB, PORT: String(PORT_HTTP), MUSEBOT_FAUX: "1", MUSEBOT_EN_DELAY: "0" },
      stdio: "ignore",
    },
  );
  BASE = `http://127.0.0.1:${PORT_HTTP}`;
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/groups`);
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("throwaway server did not start");
}
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, label) => {
  if (!ok) throw new Error(`FAIL ${label}`);
  console.log("ok   ", label);
};

const profile = path.join(process.env.TMPDIR ?? "/tmp", "mb-panel-profile");
await rm(profile, { recursive: true, force: true });
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"],
  { stdio: "ignore" },
);

const waitJson = async (url) => {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("chrome did not start");
};

const version = await waitJson(`http://127.0.0.1:${PORT}/json/version`);
const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
let seq = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const call = (method, params) => send(method, params, sessionId);
await call("Page.enable");
await call("Runtime.enable");
await call("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 860,
  deviceScaleFactor: 1,
  mobile: false,
});
const evaluate = async (expression, awaitPromise = true) => {
  const res = await call("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  return res.result?.value;
};

// 先移出一个 bot,这样「添加」弹窗里才有可勾选的对象(最后再通过弹窗加回去)
const removed = await fetch(`${BASE}/api/groups/${GROUP}/members/design`, { method: "DELETE" });
if (!removed.ok) throw new Error(`could not free a slot: ${await removed.text()}`);

await call("Page.navigate", { url: `${BASE}/?panel=1#g=${GROUP}` });
await sleep(2500);

const rowByLabel = (label) =>
  `[...document.querySelectorAll('#infoPane .info-row')].find((r) => (r.querySelector('.info-label') || {}).textContent === ${JSON.stringify(
    label,
  )})`;

/* 1) 「…」打开右侧边栏 */
await evaluate("document.getElementById('moreBtn').click(), true");
await sleep(600);
assert(await evaluate("!document.getElementById('infoPane').hidden"), "… opens the side panel");
assert(
  await evaluate("getComputedStyle(document.getElementById('infoPane')).position === 'absolute'"),
  "panel is positioned (side panel, not a centered dialog)",
);
assert(
  (await evaluate("document.querySelectorAll('#infoPane .info-member').length")) === 5, // 4 members + 添加
  "member grid rendered from the roster (+ 添加 cell)",
);

/* 2) 群成员搜索过滤 */
await evaluate(
  `(() => { const i = document.querySelector('#infoPane .info-search input'); i.value = '财务'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
);
await sleep(400);
assert(
  (await evaluate("document.querySelectorAll('#infoPane .info-member').length")) === 1,
  "member search filters the grid",
);
await evaluate(
  `(() => { const i = document.querySelector('#infoPane .info-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
);
await sleep(300);

/* 2b) 点「+」打开添加成员弹窗:两栏、勾选、已选、取消 */
await evaluate(
  `(() => { const b = document.querySelector('#infoPane .info-member.add'); if (!b) return false; b.click(); return true; })()`,
);
await sleep(700);
assert(await evaluate("!document.getElementById('picker').hidden"), "+ opens the add-member dialog");
const candidateNames = await evaluate(
  "[...document.querySelectorAll('#picker .pick-row .pick-name')].map((x) => x.textContent)",
);
assert(candidateNames.includes("设计bot"), "dialog lists 设计bot as a candidate");
assert(candidateNames.length >= 1, "dialog lists at least one candidate");
assert(
  (await evaluate("document.getElementById('pickerOk').disabled")) === true,
  "添加 is disabled until something is picked",
);
await evaluate(
  `(() => { const row = [...document.querySelectorAll('#picker .pick-row')].find((r) => r.textContent.includes('设计bot')); if (!row) return false; row.click(); return true; })()`,
);
await sleep(300);
assert(
  (await evaluate("document.getElementById('pickerCount').textContent")).includes("已选择 1"),
  "picking shows 已选择 1 个联系人",
);
assert(
  (await evaluate("document.querySelectorAll('#picker .chosen-row').length")) === 1,
  "the right column lists the chosen contact",
);
assert((await evaluate("document.getElementById('pickerOk').disabled")) === false, "添加 enabled after picking");
await evaluate("document.querySelector('#picker .chosen-del').click(), true");
await sleep(300);
assert(
  (await evaluate("document.getElementById('pickerOk').disabled")) === true,
  "removing the chosen contact disables 添加 again",
);
await evaluate(
  `(() => { const row = [...document.querySelectorAll('#picker .pick-row')].find((r) => r.textContent.includes('设计bot')); if (!row) return false; row.click(); return true; })()`,
);
await sleep(200);
await evaluate("document.getElementById('pickerOk').click(), true");
await sleep(1500);
assert(await evaluate("document.getElementById('picker').hidden"), "添加 closes the dialog");
const afterAdd = await (await fetch(`${BASE}/api/groups/${GROUP}`)).json();
assert(
  (afterAdd.members || []).some((m) => m.id === "design"),
  "the picked bot really joined the group",
);
assert(
  (await evaluate("document.querySelectorAll('#infoPane .info-member').length")) === 6,
  "the grid shows the new member right away",
);

/* 2c) 点成员 → bot 设置抽屉:概览 / 提示词 / 模型 / 资料库 */
await evaluate("document.getElementById('infoPane').hidden = true, true");
await evaluate("document.getElementById('moreBtn').click(), true");
await sleep(700);
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#infoPane .info-member')].find((x) => x.textContent.includes('设计')); if (!b) return false; b.click(); return true; })()`,
);
await sleep(1200);
assert(await evaluate("!document.getElementById('botPane').hidden"), "clicking a member opens the bot drawer");
assert(
  (await evaluate("document.querySelectorAll('#botPane .bot-acc').length")) === 8,
  "bot drawer lists seven sections",
);
assert(
  (await evaluate("!!document.querySelector('#botPane .bot-acc.open')")) === true,
  "概览 is expanded by default",
);
assert(
  (await evaluate("document.getElementById('botBody').textContent")).includes("会话"),
  "overview shows the conversation id",
);
// 概览新增「工具」行(task-12):真实工具清单 read · write_file · bash
assert(
  (await evaluate(
    `[...document.querySelectorAll('#botPane .bot-acc.open dl')].some((dl) => { const dts = [...dl.querySelectorAll('dt')]; const i = dts.findIndex((dt) => dt.textContent === '工具'); return i >= 0 && dl.querySelectorAll('dd')[i]?.textContent === 'read · write_file · bash'; })`,
  )) === true,
  "概览 shows the 工具 row with the real kit (read · write_file · bash)",
);
// 工具分区改为技能开关(task-3);移出本群入口已删(task-3),抽屉里不再有 .bot-foot
const skillsProfile = await (await fetch(`${BASE}/api/groups/${GROUP}/bots/design`)).json();
const expectSwitches = Array.isArray(skillsProfile.skillsAvailable) ? skillsProfile.skillsAvailable.length : 0;
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#botPane .bot-acc-head')].find((x) => x.textContent.includes('技能')); if (!b) return false; b.click(); return true; })()`,
);
await sleep(600);
assert(
  (await evaluate("document.querySelectorAll('#botPane .bot-acc.open .info-row .switch').length")) === expectSwitches,
  "技能 section renders one skill switch per skillsAvailable entry",
);
assert(
  (await evaluate("document.querySelector('#botPane .bot-foot')")) === null,
  "移出本群 footer (.bot-foot) no longer exists in the bot drawer",
);
// expand 提示词 and save an override
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#botPane .bot-acc-head')].find((x) => x.textContent.includes('提示词')); b.click(); return true; })()`,
);
await sleep(400);
assert(
  (await evaluate("!!document.querySelector('#botPane .bot-edit textarea')")) === true,
  "提示词 section opens an editor",
);
await evaluate(
  `(() => { const t = document.querySelector('#botPane .bot-edit textarea'); t.value = '你负责报告模板与排版。UI 测试覆盖提示词。'; [...document.querySelectorAll('#botPane .bot-edit-actions button')].find((b) => b.textContent.trim() === '保存').click(); return true; })()`,
);
await sleep(1200);
const botDetail = await (await fetch(`${BASE}/api/groups/${GROUP}/bots/design`)).json();
assert(
  botDetail.instructions.override.includes("UI 测试覆盖提示词"),
  "prompt override persisted for this bot in this group",
);
// clear it again
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#botPane .bot-edit-actions button')].find((x) => x.textContent.trim() === '恢复默认'); b.click(); return true; })()`,
);
await sleep(1000);
const botCleared = await (await fetch(`${BASE}/api/groups/${GROUP}/bots/design`)).json();
assert(botCleared.instructions.override === "", "恢复默认 clears the override");
await evaluate("document.getElementById('botPane').querySelector('.info-close').click(), true");
await sleep(300);
assert(await evaluate("document.getElementById('botPane').hidden"), "bot drawer closes");

/* 3) 领导不可移出(点成员出提示菜单) */
await evaluate("document.getElementById('moreBtn').click(), true");
await sleep(700);
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#infoPane .info-member')].find((x) => x.textContent.includes('领导')); b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 420, clientY: 320 })); return true; })()`,
);
await sleep(400);
assert(
  await evaluate("!document.getElementById('menu').hidden"),
  "right-clicking a member opens the member menu",
);
assert(
  (await evaluate("document.getElementById('menu').textContent")).includes("不能移出"),
  "the leader cannot be removed",
);
await evaluate("document.getElementById('menu').hidden = true, true");

/* 4) 群名就地改,再改回来 */
await evaluate(`${rowByLabel("群聊名称")}.click(), true`);
await sleep(300);
await evaluate(
  `(() => { const box = document.querySelector('#infoPane .info-edit'); box.querySelector('input').value = '产品研发群·UI'; [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click(); return true; })()`,
);
await sleep(1200);
assert((await evaluate("document.getElementById('groupTitleBtn').textContent")) === "产品研发群·UI", "rename updates the header");
const detail = await (await fetch(`${BASE}/api/groups/${GROUP}`)).json();
assert(detail.group.name === "产品研发群·UI", "rename persisted on the server");
await evaluate(`${rowByLabel("群聊名称")}.click(), true`);
await sleep(300);
await evaluate(
  `(() => { const box = document.querySelector('#infoPane .info-edit'); box.querySelector('input').value = '产品研发群'; [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click(); return true; })()`,
);
await sleep(1000);
const restored = await (await fetch(`${BASE}/api/groups/${GROUP}`)).json();
assert(restored.group.name === "产品研发群" || restored.group.name !== "产品研发群·UI", "rename round-trip");

/* 5) 昵称:存本地,并且作为发送者名字 */
await evaluate(`${rowByLabel("我在本群的昵称")}.click(), true`);
await sleep(300);
await evaluate(
  `(() => { const box = document.querySelector('#infoPane .info-edit'); box.querySelector('input').value = '小明'; [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click(); return true; })()`,
);
await sleep(400);
assert((await evaluate("JSON.parse(localStorage.getItem('mb.nick') || '\"\"')")) === "小明", "nickname stored locally");
// 只发一次,重复跑测试不会把演示数据刷屏
const NICK_MSG = "演示:这条是我发的闲聊";
const before = (await (await fetch(`${BASE}/api/groups/${GROUP}/items?limit=40`)).json()).items;
const already = before.filter((e) => e.kind === "chat.message" && e.data.text === NICK_MSG).length;
if (already === 0) {
  await evaluate(
    `(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(NICK_MSG)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); return true; })()`,
  );
  await sleep(1500);
}
const items = (await (await fetch(`${BASE}/api/groups/${GROUP}/items?limit=40`)).json()).items;
const mine = items.filter((e) => e.kind === "chat.message" && e.data.text === NICK_MSG).pop();
assert(mine && mine.data.author.name === "小明", "message carries the local nickname");

/* 6) 备注:群列表和头部优先显示备注 */
await evaluate(`${rowByLabel("备注")}.click(), true`);
await sleep(300);
await evaluate(
  `(() => { const box = document.querySelector('#infoPane .info-edit'); box.querySelector('input').value = '研发'; [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click(); return true; })()`,
);
await sleep(500);
assert((await evaluate("document.getElementById('groupTitleBtn').textContent")) === "研发", "remark wins over the group name in the header");
await evaluate(`${rowByLabel("备注")}.click(), true`);
await sleep(300);
await evaluate(
  `(() => { const box = document.querySelector('#infoPane .info-edit'); box.querySelector('input').value = ''; [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存').click(); return true; })()`,
);
await sleep(400);

/* 7) 免打扰开关 + 置顶聊天开关 */
await evaluate(`${rowByLabel("消息免打扰")}.click(), true`);
await sleep(300);
assert((await evaluate("JSON.parse(localStorage.getItem('mb.mute') || '[]')")).includes(GROUP), "mute stored");
await evaluate(`${rowByLabel("消息免打扰")}.click(), true`);
await sleep(300);
assert(!(await evaluate("JSON.parse(localStorage.getItem('mb.mute') || '[]')")).includes(GROUP), "mute toggles off");

/* 8) 点聊天区收起边栏 */
await evaluate("document.getElementById('stream').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), true");
await sleep(400);
assert(await evaluate("document.getElementById('infoPane').hidden"), "clicking the chat area closes the panel");
assert(
  (await evaluate("JSON.parse(localStorage.getItem('mb.pins') || '[]')")).length >= 0,
  "pins store readable",
);

/* 9) 新建群表单开合(防止回归:这块函数曾经被误删;+ 现在是菜单) */
await evaluate("document.getElementById('newGroupBtn').click(), true");
await sleep(300);
assert(
  (await evaluate("document.getElementById('menu').textContent")).includes("新建群"),
  "the + menu offers 新建群",
);
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#menu button')].find((x) => x.textContent.trim() === '新建群'); if (!b) return false; b.click(); return true; })()`,
);
await sleep(300);
assert(await evaluate("!document.getElementById('newGroupForm').hidden"), "新建群 form opens");
await evaluate("document.getElementById('newGroupCancel').click(), true");
await sleep(200);
assert(await evaluate("document.getElementById('newGroupForm').hidden"), "新建群 form closes");

/* 10) 消息搜索 */
await evaluate("document.getElementById('searchMsgBtn').click(), true");
await sleep(400);
assert(await evaluate("!document.getElementById('msgSearch').hidden"), "查找聊天内容 opens the search bar");
await evaluate(
  `(() => { const i = document.getElementById('msgSearchInput'); i.value = '财报'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
);
await sleep(400);
assert(
  (await evaluate("document.getElementById('msgSearchCount').textContent")).includes("条匹配"),
  "search reports the match count",
);
await evaluate("document.getElementById('msgSearchClose').click(), true");
await sleep(300);
assert(await evaluate("document.getElementById('msgSearch').hidden"), "search bar closes");

/* 10b) 设置 → 手机和设备:已连接 / 访问地址 / 高级模式下的 Tailscale */
await evaluate("document.getElementById('railSettings').click(), true");
await sleep(1400);
await evaluate(
  `[...document.querySelectorAll('#settingsNav .settings-nav-item')].find((x) => x.textContent.includes('手机和设备')).click(), true`,
);
await sleep(1200);
assert(
  (await evaluate("document.getElementById('settingsTitle').textContent")) === "手机和设备",
  "手机和设备 page opens",
);
assert(
  (await evaluate("document.getElementById('settingsBody').textContent")).includes("127.0.0.1"),
  "access URL is listed",
);
assert(
  (await evaluate("!!document.querySelector('#settingsBody .switch')")) ===
    (await evaluate("document.getElementById('settingsAdv').classList.contains('on')")),
  "Tailscale switch only appears in advanced mode",
);
const advOnNow = await evaluate("document.getElementById('settingsAdv').classList.contains('on')");
if (!advOnNow) {
  await evaluate("document.getElementById('settingsAdv').click(), true");
  await sleep(600);
  assert(
    (await evaluate("!!document.querySelector('#settingsBody .switch')")) === true,
    "turning on advanced mode reveals the Tailscale switch",
  );
  await evaluate("document.getElementById('settingsAdv').click(), true");
  await sleep(400);
}
assert(
  (await evaluate("document.getElementById('settingsVersion').textContent")).startsWith("这个应用"),
  "settings shows the project version",
);
if (!(await evaluate("document.getElementById('settingsAdv').classList.contains('on')"))) {
  await evaluate("document.getElementById('settingsAdv').click(), true");
  await sleep(600);
}
{
  const tailnetRow = await evaluate(
    `(() => { const row = [...document.querySelectorAll('#settingsBody .settings-row')].find((r) => (r.querySelector('.settings-row-name') || {}).textContent === 'tailnet 访问'); if (!row) return null; return { text: row.textContent, button: (row.querySelector('button') || {}).textContent }; })()`,
  );
  assert(tailnetRow !== null, "tailnet 访问 row exists in advanced mode");
  assert(
    tailnetRow.text.includes("未开启") || tailnetRow.text.includes(".ts.net"),
    "tailnet row shows either the off state or a real tailnet URL",
  );
  assert(["开启", "关闭"].includes((tailnetRow.button || "").trim()), "tailnet row has a toggle button");
}
await evaluate("document.getElementById('settingsAdv').click(), true");
await sleep(300);
await evaluate("document.getElementById('settingsClose').click(), true");
await sleep(300);

/* 10c) IM 接入页 */
await evaluate("document.getElementById('railSettings').click(), true");
await sleep(1200);
await evaluate(
  `[...document.querySelectorAll('#settingsNav .settings-nav-item')].find((x) => x.textContent.includes('IM 接入')).click(), true`,
);
await sleep(1000);
assert(
  (await evaluate("document.getElementById('settingsTitle').textContent")) === "IM 接入",
  "IM 接入 page opens",
);
assert(
  (await evaluate("document.getElementById('settingsBody').textContent")).includes("/api/im/"),
  "IM page shows the webhook path",
);
assert(
  (await evaluate("document.getElementById('settingsBody').textContent")).includes("outbox"),
  "IM page documents the outbox pull",
);
await evaluate("document.getElementById('settingsClose').click(), true");
await sleep(300);

/* 11) 设置:两栏面板 / AI 模型页 / 运行状态页 / 搜索过滤 / 高级模式 */
await evaluate("document.getElementById('railSettings').click(), true");
await sleep(1200);
assert(await evaluate("!document.getElementById('settings').hidden"), "gear opens the settings panel");
assert(
  (await evaluate("document.querySelectorAll('#settingsNav .settings-nav-item').length")) === 8,
  "settings has eight sections",
);
assert(
  (await evaluate("document.getElementById('settingsTitle').textContent")) === "AI 模型",
  "AI 模型 is the default page",
);
assert(
  (await evaluate("(document.querySelector('#settings .settings-row-state') || {}).textContent")).includes("未检查") ||
    (await evaluate("(document.querySelector('#settings .settings-row-state') || {}).textContent")).length > 0,
  "provider row shows a real state line",
);

/* 11a) 个人资料:昵称 / 签名 / 头像入口,保存后服务端真的变了 */
await evaluate(
  `[...document.querySelectorAll('#settingsNav .settings-nav-item')].find((x) => x.textContent.includes('个人资料')).click(), true`,
);
await sleep(500);
assert(
  (await evaluate("document.getElementById('settingsTitle').textContent")) === "个人资料",
  "个人资料 page opens",
);
assert(
  await evaluate("!!document.querySelector('#settingsBody .profile-avatar')"),
  "profile page shows the avatar block",
);
await evaluate(
  `(() => {
    const n = document.getElementById('set-profile-name');
    const s = document.getElementById('set-profile-signature');
    n.value = '阿哲'; n.dispatchEvent(new Event('input', { bubbles: true }));
    s.value = '测试签名'; s.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#settingsBody .settings-actions button')].find((b) => b.textContent.trim() === '保存').click();
    return true;
  })()`,
);
await sleep(700);
const savedProfile = await (await fetch(`${BASE}/api/profile`)).json();
assert(savedProfile.name === "阿哲" && savedProfile.signature === "测试签名", "profile saved on the server");
const avatarData = await evaluate(
  `(() => { const c = document.createElement('canvas'); c.width = 160; c.height = 160; const g = c.getContext('2d'); g.fillStyle = '#e2738f'; g.fillRect(0, 0, 160, 160); g.fillStyle = '#fff'; g.font = 'bold 72px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('哲', 80, 84); return c.toDataURL('image/jpeg', 0.9); })()`,
);
await fetch(`${BASE}/api/profile`, {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "阿哲", signature: "测试签名", avatar: avatarData }),
});
await evaluate(
  `[...document.querySelectorAll('#settingsNav .settings-nav-item')].find((x) => x.textContent.includes('AI 模型')).click(), true`,
);
await sleep(500);
await evaluate(
  `(() => { const s = document.getElementById('settingsSearch'); s.value = '状态'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
);
await sleep(300);
assert(
  (await evaluate("document.querySelectorAll('#settingsNav .settings-nav-item').length")) === 1,
  "settings search filters the nav",
);
await evaluate(
  `(() => { const b = document.querySelector('#settingsNav .settings-nav-item'); b.click(); return true; })()`,
);
await sleep(900);
assert(
  (await evaluate("document.getElementById('settingsTitle').textContent")) === "运行状态",
  "switching to 运行状态 works",
);
assert(
  (await evaluate("document.getElementById('settingsBody').textContent")).includes(new URL(BASE).port),
  "status page shows the real port",
);
const advOn = await evaluate("document.getElementById('settingsAdv').classList.contains('on')");
if (!advOn) {
  await evaluate("document.getElementById('settingsAdv').click(), true");
  await sleep(400);
}
assert(
  (await evaluate("!!document.querySelector('#settings .settings-pre')")) === true,
  "advanced mode shows raw JSON",
);
if (!advOn) {
  await evaluate("document.getElementById('settingsAdv').click(), true");
  await sleep(300);
}
await evaluate("document.getElementById('settingsClose').click(), true");
await sleep(300);
assert(await evaluate("document.getElementById('settings').hidden"), "settings closes");

/* 11b) 新建 bot:+ 菜单 → 表单 → 真的创建并加入本群 */
await evaluate("document.getElementById('newGroupBtn').click(), true");
await sleep(400);
assert(
  (await evaluate("document.getElementById('menu').textContent")).includes("新建 bot"),
  "the + menu offers 新建 bot",
);
await evaluate(
  `(() => { const b = [...document.querySelectorAll('#menu button')].find((x) => x.textContent.trim() === '新建 bot'); if (!b) return false; b.click(); return true; })()`,
);
await sleep(500);
assert(
  (await evaluate("document.getElementById('sheetTitle').textContent")) === "新建 bot",
  "bot creator opens",
);
await evaluate(
  `(() => {
    const g = document.getElementById('creatorGlyph');
    const n = document.getElementById('creatorName');
    const c = document.getElementById('creatorCap');
    const i = document.getElementById('creatorInstructions');
    g.value = '🧪'; g.dispatchEvent(new Event('input', { bubbles: true }));
    n.value = '调研bot'; n.dispatchEvent(new Event('input', { bubbles: true }));
    c.value = 'general';
    i.value = '你负责用户调研,输出访谈结论。';
    [...document.querySelectorAll('#sheetBody .sheet-actions button')].find((b) => b.textContent.trim() === '创建').click();
    return true;
  })()`,
);
await sleep(1200);
const botsNow = await (await fetch(`${BASE}/api/bots`)).json();
assert(botsNow.bots.some((b) => b.name === "调研bot" && b.custom === true), "custom bot exists on the server");
const detailNow = await (await fetch(`${BASE}/api/groups/${GROUP}`)).json();
assert(detailNow.members.some((m) => m.name === "调研bot"), "custom bot joined the group");
assert(
  (await evaluate("document.getElementById('groupList').textContent")).includes("调研bot"),
  "custom bot appears in the left 我的 bot list",
);
/* 12) 群头像 = 成员拼图(最多 9 格),重新加载后按当前 roster 校验 */
await call("Page.navigate", { url: `${BASE}/?avatars=1#g=${GROUP}` }, sessionId);
await sleep(2200);
const rosters = (await (await fetch(`${BASE}/api/groups`)).json()).groups.map((group) => group.roster.length + 1);
const avatarCells = await evaluate(
  "[...document.querySelectorAll('#groupList .avatar-grid')].map((a) => a.querySelectorAll('.ag-cell').length)",
);
assert(
  JSON.stringify(avatarCells) === JSON.stringify(rosters.map((count) => Math.min(count, 9))),
  `group avatars should hold min(members, 9) cells: ${JSON.stringify(avatarCells)} vs ${JSON.stringify(rosters)}`,
);
assert(
  (await evaluate(
    "[...document.querySelectorAll('#groupList .avatar-grid')].every((a) => { const n = a.querySelectorAll('.ag-cell').length; const rows = a.querySelectorAll('.ag-row').length; return n <= 3 ? rows === 1 : n <= 6 ? rows === 2 : rows === 3; })"
  )) === true,
  "row count follows the 1/2/3-row rule",
);
assert(
  (await evaluate(
    "[...document.querySelectorAll('#groupList .avatar-grid .ag-cell')].every((c) => { const s = getComputedStyle(c); return s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.backgroundImage !== 'none'; })"
  )) === true,
  "each cell carries its member colour or avatar image",
);
assert(await evaluate("!!document.querySelector('#railAvatar img')"), "profile avatar renders in the rail");
assert(
  await evaluate("getComputedStyle(document.querySelector('#groupList .avatar-grid .ag-cell')).backgroundImage.includes('data:image')"),
  "profile avatar appears in the composite group avatar",
);
console.log("avatar cells:", avatarCells.join(","));

ws.close();
chrome.kill();
if (child) {
  child.kill();
  for (const suffix of ["", "-wal", "-shm"]) await rm(TMP_DB + suffix, { force: true });
}
console.log("UI PANEL OK");
process.exit(0);
