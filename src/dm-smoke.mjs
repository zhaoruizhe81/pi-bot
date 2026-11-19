// DM direct-chat smoke, offline (faux provider). Two layers:
//   1. In-process (createMusebot + scripted faux): a DM line drives one direct generation
//      round on the bot's own conversation — the group only ever sees
//      [chat.message(human), work.event(正在处理…), chat.message(bot)]; a write_file inside
//      the round leaves a readable pi.tool-result (the content-block contract), and a second
//      line queues behind the first and answers in order.
//   2. Spawned server on an independent port (faux): same DM signature over HTTP, and the
//      normal group regression is untouched (planning → plan → delivered → done).
// Run from bot/:
//   node --experimental-strip-types src/dm-smoke.mjs
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { createMusebot } from "./app.ts";
import { FAUX_MODEL } from "./config/model.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, label) => {
  if (!ok) throw new Error(`FAIL ${label}`);
  console.log("ok  ", label);
};
const waitFor = async (test, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const CARD_EVS = new Set(["plan", "planning", "assigned", "started", "delivered", "done", "failed", "cancelled", "blocked"]);
const textOfEntry = (entry) =>
  (entry.model?.[0]?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

/* ===== Layer 1: in-process, scripted faux ===== */
const tmpRoot = await mkdtemp(path.join(tmpdir(), "musebot-dm-"));
const app = await createMusebot(
  {
    storageFile: ":memory:",
    model: FAUX_MODEL,
    workDelayMs: 0,
    workspaceRoot: path.join(tmpRoot, "workspace"),
    archiveRoot: path.join(tmpRoot, "archive"),
    uploadRoot: path.join(tmpRoot, "uploads"),
  },
  ctx,
);
await app.openDm("leader");
// Replace the canned provider with our own handle (same "faux" id) so rounds are scriptable.
const faux = fauxProvider();
app.models.setProvider(faux.provider);
const toolCall = (name, args, id) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

const dmKinds = async () => (await app.readItems("dm-leader")).map((i) => ({ kind: i.kind, ev: i.data?.ev, author: i.data?.author, text: i.data?.text }));
const assertNoCards = async (label) => {
  const rows = await dmKinds();
  const cards = rows.filter((row) => row.kind === "work.event" && CARD_EVS.has(row.ev));
  assert(cards.length === 0, `${label}: no plan/delivery cards in the DM stream [${rows.map((r) => r.ev ?? r.kind).join(", ")}]`);
};

// Round 1: the bot writes a file, then answers in text.
faux.setResponses([
  toolCall("write_file", { path: "dm-note.md", content: "私聊交付样例" }, "dmw1"),
  fauxAssistantMessage([fauxText("文件写好了,在 dm-note.md")]),
]);
await app.chat("dm-leader", { text: "帮我在私聊里写个 dm-note.md" });
await waitFor(async () => {
  const rows = await dmKinds();
  return rows.some((row) => row.kind === "chat.message" && row.author?.type === "bot");
}, 30000, "the DM bot's reply bubble");
await assertNoCards("round 1");

let rows = await dmKinds();
assert(
  JSON.stringify(rows.map((row) => `${row.kind}:${row.ev ?? ""}`)) ===
    JSON.stringify(["chat.message:", "work.event:正在处理…", "chat.message:"]),
  `round 1 signature is human bubble -> working row -> bot bubble [${rows.map((r) => `${r.kind}:${r.ev ?? ""}`).join(" | ")}]`,
);
assert(rows[0].author?.type === "human", "the first entry is the human line");
assert(rows[2].author?.type === "bot" && rows[2].author?.id === "leader", "the reply is authored by the DM bot");
assert(String(rows[2].text).includes("dm-note.md"), "the reply carries the bot's answer text");

// The write_file round left a readable tool result in the bot's own conversation.
const runtime = app.group("dm-leader");
const convId = runtime.conversationIdFor("leader");
const conv = await app.harness.conversation(convId, ctx);
const transcript = await conv.entries({}, 40, undefined, ctx);
const writeResults = [...transcript.items]
  .reverse()
  .filter((entry) => ToolResultEntry.is(entry) && entry.model?.[0]?.toolName === "write_file");
assert(writeResults.length === 1, "the bot conversation holds a pi.tool-result for write_file");
assert(textOfEntry(writeResults[0]).includes("已写入 dm-note.md ("), `write_file's result text survives: ${JSON.stringify(textOfEntry(writeResults[0]))}`);
const notePath = path.join(tmpRoot, "workspace", String(convId), "dm-note.md");
assert((await readFile(notePath, "utf8")) === "私聊交付样例", "write_file landed in the bot's workspace");

// Round 2: a second line while nothing runs; multi-turn keeps order.
faux.setResponses([fauxAssistantMessage([fauxText("这是第二轮的回答")])]);
await app.chat("dm-leader", { text: "再聊一句" });
await waitFor(async () => {
  const next = await dmKinds();
  return next.filter((row) => row.kind === "chat.message" && row.author?.type === "bot").length === 2;
}, 30000, "the second DM reply");
await assertNoCards("round 2");
rows = await dmKinds();
assert(
  rows.length === 6 && rows[5].text === "这是第二轮的回答",
  `round 2 appends in order [${rows.map((r) => `${r.kind}:${r.ev ?? r.text ?? ""}`).join(" | ")}]`,
);
await app.close();
await rm(tmpRoot, { recursive: true, force: true });

/* ===== Layer 2: spawned server on an independent port ===== */
const botDir = fileURLToPath(new URL("../", import.meta.url));
const PORT = 18700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DB = `/tmp/mb-dm-smoke-${Date.now()}.db`;
const postJson = (p, body) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const itemsOf = async (gid) => (await (await fetch(`${BASE}/api/groups/${gid}/items?limit=200`)).json()).items;

const child = spawn(process.execPath, ["--experimental-strip-types", "src/main.ts"], {
  cwd: botDir,
  env: { ...process.env, MUSEBOT_DB: TMP_DB, PORT: String(PORT), MUSEBOT_FAUX: "1", MUSEBOT_DELAY: "0" },
  stdio: "ignore",
});
let ready = false;
for (let i = 0; i < 120 && !ready; i += 1) {
  try {
    ready = (await fetch(`${BASE}/api/groups`)).ok;
  } catch {
    /* not up yet */
  }
  if (!ready) await sleep(100);
}
if (!ready) {
  child.kill();
  throw new Error("throwaway server did not start");
}

try {
  const open = await postJson("/api/dm/leader/open", {});
  assert(open.status === 200, "POST /api/dm/leader/open answers 200");
  assert((await postJson("/api/dm/nosuchbot/open", {})).status === 404, "unknown DM bot answers 404");

  await postJson("/api/groups/dm-leader/send", { text: "私聊里直接问一句", author: { type: "human", id: "u1", name: "我" } });
  await waitFor(async () => {
    const items = await itemsOf("dm-leader");
    return items.some((i) => i.kind === "chat.message" && i.data?.author?.type === "bot");
  }, 30000, "the DM bot's HTTP reply bubble");
  const dmItems = await itemsOf("dm-leader");
  const dmCards = dmItems.filter((i) => i.kind === "work.event" && CARD_EVS.has(i.data?.ev));
  assert(dmCards.length === 0, `HTTP DM stream has no cards [${dmItems.map((i) => `${i.kind}:${i.data?.ev ?? ""}`).join(" | ")}]`);
  assert(
    JSON.stringify(dmItems.map((i) => `${i.kind}:${i.data?.ev ?? ""}`)) ===
      JSON.stringify(["chat.message:", "work.event:正在处理…", "chat.message:"]),
    "HTTP DM signature is human bubble -> working row -> bot bubble",
  );

  // Regression: the same text in the normal group still plans and delivers with cards.
  await postJson("/api/groups/g1/send", { text: "帮我整理一版季度复盘报告", author: { type: "human", id: "u1", name: "我" } });
  await waitFor(async () => {
    const items = await itemsOf("g1");
    return items.some((i) => i.kind === "work.event" && i.data?.ev === "planning");
  }, 30000, "leader planning in the normal group");
  await waitFor(async () => {
    const items = await itemsOf("g1");
    return items.some((i) => i.kind === "work.event" && i.data?.ev === "delivered") && items.some((i) => i.kind === "work.event" && i.data?.ev === "done");
  }, 30000, "the normal group's delivery");
  const normalEvents = (await itemsOf("g1")).filter((i) => i.kind === "work.event").map((i) => i.data?.ev);
  assert(normalEvents.includes("plan"), `the normal group still shows the plan card [${normalEvents.join(", ")}]`);
  assert(normalEvents.includes("delivered") && normalEvents.includes("done"), "the normal group still delivers with cards");
  console.log("normal events :", normalEvents.join(", "));
} finally {
  child.kill();
  for (const suffix of ["", "-wal", "-shm"]) await rm(TMP_DB + suffix, { force: true });
}

console.log("DM SMOKE OK");
process.exit(0);
