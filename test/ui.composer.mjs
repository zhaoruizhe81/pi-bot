// The composer tools must actually work: emoji inserts, 文件/图片 upload, 语音 records.
// Hermetic: throwaway server + temp DB, headless Chrome with a fake microphone.
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const botDir = fileURLToPath(new URL("../", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, label) => {
  if (!ok) throw new Error(`FAIL ${label}`);
  console.log("ok   ", label);
};

const PORT_HTTP = 18980 + Math.floor(Math.random() * 60);
const TMP = `/tmp/mb-composer-${Date.now()}`;
const BASE = `http://127.0.0.1:${PORT_HTTP}`;

const server = spawn(process.execPath, ["--experimental-strip-types", "src/main.ts"], {
  cwd: botDir,
  env: {
    ...process.env,
    MUSEBOT_DB: `${TMP}.db`,
    MUSEBOT_FAUX: "1",
    MUSEBOT_WORKSPACE: `${TMP}-workspace`,
    MUSEBOT_UPLOADS: `${TMP}-uploads`,
    PORT: String(PORT_HTTP),
  },
  stdio: "ignore",
});

for (let i = 0; i < 120; i += 1) {
  try {
    const res = await fetch(`${BASE}/api/groups`);
    if (res.ok) break;
  } catch {
    /* not up */
  }
  await sleep(100);
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CPORT = 9351;
const profile = `${TMP}-chrome`;
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${CPORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const version = await (async () => {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CPORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not up */
    }
    await sleep(100);
  }
  throw new Error("chrome did not start");
})();

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
await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 830, deviceScaleFactor: 2, mobile: false });
await call("Page.navigate", { url: `${BASE}/#g=g1` });
await sleep(2500);

const evaluate = async (expression) => {
  const res = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  return res.result?.value;
};
const items = async () => (await (await fetch(`${BASE}/api/groups/g1/items?limit=50`)).json()).items;

/* 1) 表情:点开面板,点一个 emoji,真的进了输入框 */
await evaluate("document.getElementById('toolEmoji').click(), true");
await sleep(400);
assert(await evaluate("!document.getElementById('emojiPanel').hidden"), "表情 opens the emoji panel");
const firstEmoji = await evaluate("document.querySelector('#emojiPanel button').textContent");
await evaluate("document.querySelector('#emojiPanel button').click(), true");
await sleep(300);
assert(
  (await evaluate("document.getElementById('input').value")).includes(firstEmoji),
  `clicking ${firstEmoji} inserts it into the composer`,
);
await evaluate("document.getElementById('input').value = '', true");
await evaluate("document.getElementById('toolEmoji').click(), true");
await sleep(200);

/* 2) 文件:真实上传,服务端多一条 chat.file,列表多一个文件气泡 */
// 注意:change 处理函数读完后会清空 input(避免重复发送),所以这里只能断言副作用。
await evaluate(`(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['hello from composer'], '说明.txt', { type: 'text/plain' }));
  const input = document.getElementById('fileInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(1800);
let list = await items();
let fileEntries = list.filter((e) => e.kind === "chat.file");
assert(fileEntries.length === 1, `server should hold one chat.file, got ${fileEntries.length}`);
assert(fileEntries[0].data.file.name === "说明.txt", "uploaded file keeps its name");
assert(
  (await evaluate("document.querySelectorAll('#stream .chat-file').length")) >= 1,
  "the file renders as a file bubble in the chat",
);

/* 3) 图片:canvas 生成 PNG,上传后 <img> 直接显示 */
await evaluate(`(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#07c160'; ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText('图', 18, 42);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], '测试图片.png', { type: 'image/png' }));
  const input = document.getElementById('imageInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(1800);
list = await items();
const images = list.filter((e) => e.kind === "chat.file" && String(e.data.file.mime).startsWith("image/"));
assert(images.length === 1, "image upload stored as chat.file with an image mime");
assert(
  (await evaluate("document.querySelectorAll('#stream .chat-file img').length")) >= 1,
  "the image renders inline",
);

/* 4) 语音:fake 麦克风录 1.5 秒,发出去是 <audio> */
await evaluate("document.getElementById('toolVoice').click(), true");
let voiceUp = false;
for (let i = 0; i < 40; i += 1) {
  voiceUp = await evaluate("!document.getElementById('voiceBar').hidden");
  if (voiceUp) break;
  await sleep(250);
}
if (!voiceUp) {
  console.log("      toast:", await evaluate("document.getElementById('toast').textContent"));
  console.log("      media:", await evaluate("typeof navigator.mediaDevices + ' ' + typeof MediaRecorder"));
}
assert(voiceUp, "voice bar appears while recording");
await sleep(1500);
await evaluate("document.getElementById('toolVoice').click(), true");
await sleep(2500);
assert(await evaluate("document.getElementById('voiceBar').hidden"), "voice bar hides after stop");
list = await items();
const audio = list.filter((e) => e.kind === "chat.file" && String(e.data.file.mime).startsWith("audio/"));
assert(audio.length === 1, `voice message stored as chat.file audio, got ${audio.length}`);
assert(
  (await evaluate("document.querySelectorAll('#stream .chat-file audio').length")) >= 1,
  "the voice message renders an audio player",
);

/* 5) 左栏 = 聊天 + 通讯录 + 我:通讯录真的能用,收藏/朋友圈已移除 */
assert(
  (await evaluate("[...document.querySelectorAll('.rail-nav .rail-btn')].map((b) => b.id).join(',')")) === "railChat,railContacts",
  "rail nav holds chat + contacts only",
);
assert(
  (await evaluate("['railFiles','railMoments'].every((id) => !document.getElementById(id))")) === true,
  "favorites/moments rail icons are gone",
);
assert(
  (await evaluate("document.querySelectorAll('#groupList .bot-section .bot-row').length")) >= 5,
  "all bots are visible below the group list",
);
await evaluate("document.getElementById('railContacts').click(), true");
await sleep(600);
await sleep(400);
assert(
  (await evaluate("!document.getElementById('contactsWindow').hidden && document.getElementById('contactsList').textContent.includes('领导')")) === true,
  "contacts opens a usable bot directory",
);
await evaluate("document.getElementById('contactsClose').click(), true");
await sleep(200);
await evaluate("document.getElementById('railMe').click(), true");
await sleep(800);
assert(
  (await evaluate("document.getElementById('settingsTitle').textContent")) === "个人资料",
  "clicking my avatar opens 个人资料",
);
await evaluate("document.getElementById('settingsClose').click(), true");
await sleep(300);

/* 6) 重复的「文件夹」按钮已移除,工具栏只剩 表情/文件/图片/语音 */
const tools = await evaluate("[...document.querySelectorAll('.composer .tool')].map((b) => b.id).join(',')");
assert(tools === "toolEmoji,toolFile,toolImage,toolVoice", `toolbar should be exactly four tools, got ${tools}`);

// 截图时把表情面板也打开,一眼看到四件工具都是真的
await evaluate("document.getElementById('toolEmoji').click(), true");
await sleep(400);
const { data } = await call("Page.captureScreenshot", { format: "jpeg", quality: 90 });
await import("node:fs/promises").then((fs) => fs.writeFile(path.join(botDir, "docs", "webui-composer.jpg"), Buffer.from(data, "base64")));
console.log("saved docs/webui-composer.jpg");

ws.close();
chrome.kill();
server.kill();
for (const suffix of ["", "-wal", "-shm"]) await rm(`${TMP}.db${suffix}`, { force: true });
await rm(`${TMP}-workspace`, { recursive: true, force: true }).catch(() => undefined);
await rm(`${TMP}-uploads`, { recursive: true, force: true }).catch(() => undefined);
await sleep(500);
await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
console.log("COMPOSER OK");
process.exit(0);
