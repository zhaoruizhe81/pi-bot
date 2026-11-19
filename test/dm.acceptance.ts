// DM + tools acceptance (hermetic, like ui.panel.mjs / src/dm-smoke): two layers, one run.
//   1. In-process (createMusebot + scripted faux): a DM round drives the real tool kit
//      through durable's pipeline — write_file lands and `read` reads it back inside the
//      same DM round (the pi.tool-result content-block contract lock), bash pwd/echo run in
//      the session workspace, a timeout gets killed with a note, and a path escape is
//      rejected — while the channel keeps the pure-dialog signature
//      [chat.message(human), work.event(正在处理…), chat.message(bot)].
//   2. Spawned faux server (HTTP): /api/dm/leader/open idempotency, type "dm",
//      profile.tools = [read, write_file, bash], DM send → signature with zero card events,
//      multi-turn appends the three-piece in order, the normal group still
//      planning → … → done, and an unknown bot answers 404.
// Run from bot/:
//   npm run dm:accept
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import { createMusebot } from "../src/app.ts";
import { FAUX_MODEL } from "../src/config/model.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (ok, label) => {
  if (!ok) throw new Error(`FAIL ${label}`);
  console.log("ok   ", label);
};
const waitFor = async (test, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const CARD_EVS = new Set(["plan", "planning", "assigned", "started", "blocked", "delivered", "done", "failed", "cancelled"]);
const SIGNATURE = ["chat.message:", "work.event:正在处理…", "chat.message:"];
const sigOf = (rows) => JSON.stringify(rows.map((r) => `${r.kind}:${r.ev ?? ""}`));
const textOfEntry = (entry) =>
  (entry.model?.[0]?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

/* ===== Layer 1: in-process, scripted faux — the tool kit inside DM rounds ===== */
const tmpRoot = await mkdtemp(path.join(tmpdir(), "musebot-dm-accept-"));
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

const dmRows = async () =>
  (await app.readItems("dm-leader")).map((i) => ({ kind: i.kind, ev: i.data?.ev, author: i.data?.author, text: i.data?.text }));
const assertNoCards = async (label) => {
  const rows = await dmRows();
  const cards = rows.filter((row) => row.kind === "work.event" && CARD_EVS.has(row.ev));
  assert(cards.length === 0, `${label}: no card events in the DM stream [${rows.map((r) => r.ev ?? r.kind).join(", ")}]`);
};
const botBubbles = async () =>
  (await dmRows()).filter((r) => r.kind === "chat.message" && r.author?.type === "bot").length;

// Round 1: the DM bot writes a file and reads it back — the write_file contract lock (E2).
faux.setResponses([
  toolCall("write_file", { path: "dm-note.md", content: "私聊交付样例\n第二行" }, "w1"),
  toolCall("read", { path: "dm-note.md" }, "r1"),
  fauxAssistantMessage([fauxText("文件写好了,在 dm-note.md")]),
]);
await app.chat("dm-leader", { text: "私聊里写个 dm-note.md 再读回来" });
await waitFor(async () => (await botBubbles()) >= 1, 30000, "the DM bot's reply bubble");
await assertNoCards("round 1");
let rows = await dmRows();
assert(
  sigOf(rows) === JSON.stringify(SIGNATURE),
  `round 1 signature is human bubble -> working row -> bot bubble [${rows.map((r) => `${r.kind}:${r.ev ?? ""}`).join(" | ")}]`,
);
assert(rows[0].author?.type === "human", "the first entry is the human line");
assert(rows[2].author?.type === "bot" && rows[2].author?.id === "leader", "the reply is authored by the DM bot");

const runtime = app.group("dm-leader");
const convId = runtime.conversationIdFor("leader");
const conv = await app.harness.conversation(convId, ctx);
// transcript.items come newest-first; reverse() restores chronological order.
const resultsOf = async () =>
  [...(await (await conv.entries({}, 60, undefined, ctx)).items)].reverse().filter((entry) => ToolResultEntry.is(entry));
const byTool = (results, name) => results.filter((entry) => entry.model?.[0]?.toolName === name);

let results = await resultsOf();
assert(byTool(results, "write_file").length === 1, "the DM conversation holds a pi.tool-result for write_file");
assert(
  textOfEntry(byTool(results, "write_file")[0]).includes("已写入 dm-note.md ("),
  "write_file's result text survives (content-block contract)",
);
assert(textOfEntry(byTool(results, "read")[0]).includes("私聊交付样例"), "read reads back the file write_file wrote in the DM session");
const notePath = path.join(tmpRoot, "workspace", String(convId), "dm-note.md");
assert((await readFile(notePath, "utf8")) === "私聊交付样例\n第二行", "write_file landed in the bot's session workspace");

// Round 2: bash in the session workspace, a killed timeout, and a rejected escape.
faux.setResponses([
  toolCall("bash", { command: "pwd" }, "b1"),
  toolCall("bash", { command: "echo hi" }, "b2"),
  toolCall("bash", { command: "sleep 3", timeoutMs: 1000 }, "b3"),
  toolCall("read", { path: "../escape.txt" }, "r2"),
  fauxAssistantMessage([fauxText("命令跑完了")]),
]);
await app.chat("dm-leader", { text: "跑几条命令试试" });
await waitFor(async () => (await botBubbles()) >= 2, 30000, "the second DM reply");
await assertNoCards("round 2");
rows = await dmRows();
assert(
  rows.length === 6 && sigOf(rows) === JSON.stringify([...SIGNATURE, ...SIGNATURE]),
  `round 2 appends the three-piece in order [${rows.map((r) => `${r.kind}:${r.ev ?? r.text ?? ""}`).join(" | ")}]`,
);
assert(rows[3].author?.type === "human" && rows[3].text === "跑几条命令试试", "the second round keeps the human line verbatim");
assert(rows[5].author?.type === "bot" && rows[5].text === "命令跑完了", "the second round answers with a bot bubble");

results = await resultsOf();
const bashes = byTool(results, "bash");
assert(
  textOfEntry(bashes[0]).includes("$ pwd") && textOfEntry(bashes[0]).includes(String(convId)),
  "bash pwd runs in the session workspace",
);
assert(textOfEntry(bashes[1]).includes("$ echo hi\nhi"), "bash echo hi works");
assert(
  textOfEntry(bashes[2]).includes("已被终止(killed)") && textOfEntry(bashes[2]).includes("1000ms"),
  "bash timeout kills the command and says so",
);
const reads = byTool(results, "read");
assert(textOfEntry(reads[1]).includes("escapes the workspace"), "read rejects a path outside the session workspace");

await app.close();
await rm(tmpRoot, { recursive: true, force: true });

/* ===== Layer 2: spawned faux server — DM signature over HTTP ===== */
const botDir = fileURLToPath(new URL("../", import.meta.url));
const PORT = 18500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DB = `/tmp/mb-dm-accept-${Date.now()}.db`;
const postJson = (p, body) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const itemsOf = async (gid) => (await (await fetch(`${BASE}/api/groups/${gid}/items?limit=200`)).json()).items;
const httpSigOf = (items) => JSON.stringify(items.map((i) => `${i.kind}:${i.data?.ev ?? ""}`));

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
  const TASK = "帮我整理一版季度复盘报告";

  /* 1) open twice — byte-identical idempotent doc, type "dm" */
  const res1 = await postJson("/api/dm/leader/open", {});
  const body1 = await res1.text();
  const doc1 = JSON.parse(body1);
  assert(res1.status === 200, "POST /api/dm/leader/open answers 200");
  assert(doc1.type === "dm", "the opened group carries type \"dm\"");
  assert(doc1.id === "dm-leader", "the DM group id is dm-<botId>");
  assert(JSON.stringify(doc1.roster) === JSON.stringify(["leader"]), "the DM roster is exactly [leader]");
  const res2 = await postJson("/api/dm/leader/open", {});
  const body2 = await res2.text();
  assert(res2.status === 200 && body1 === body2, "opening twice returns the byte-identical group doc");

  /* 2) group listings expose the type field */
  const groups = (await (await fetch(`${BASE}/api/groups`)).json()).groups;
  const dmRow = groups.find((g) => g.id === "dm-leader");
  const normalRow = groups.find((g) => g.id !== "dm-leader");
  assert(dmRow && dmRow.type === "dm", "the groups list carries the DM type");
  assert(normalRow && normalRow.type !== "dm", "normal groups are not typed as dm");
  const normalId = normalRow.id;
  const dmDetail = (await (await fetch(`${BASE}/api/groups/dm-leader`)).json()).group;
  assert(dmDetail.type === "dm", "the group document carries type \"dm\"");

  /* 3) unknown bot answers 404 */
  const miss = await postJson("/api/dm/nosuchbot/open", {});
  assert(miss.status === 404, "POST /api/dm/nosuchbot/open answers 404");

  /* 4) profile exposes the real tool kit */
  const profile = await (await fetch(`${BASE}/api/groups/g1/bots/leader`)).json();
  assert(
    JSON.stringify(profile.tools) === JSON.stringify(["read", "write_file", "bash"]),
    `profile.tools is the real kit: ${JSON.stringify(profile.tools)}`,
  );
  assert(Array.isArray(profile.skills) && Array.isArray(profile.skillsAvailable), "profile still carries the skill lists");

  /* 5) DM routing: pure dialog — human bubble, working row, bot bubble, zero cards */
  const sent = await postJson("/api/groups/dm-leader/send", {
    text: "私聊里直接问一句",
    author: { type: "human", id: "u1", name: "我" },
  });
  assert(sent.status === 200, "send to the DM group answers 200");
  await waitFor(async () => {
    const items = await itemsOf("dm-leader");
    return items.some((i) => i.kind === "chat.message" && i.data?.author?.type === "bot");
  }, 30000, "the DM bot's HTTP reply bubble");
  let dmItems = await itemsOf("dm-leader");
  const dmCards = dmItems.filter((i) => i.kind === "work.event" && CARD_EVS.has(i.data?.ev));
  assert(dmCards.length === 0, `HTTP DM stream has no card events [${dmItems.map((i) => `${i.kind}:${i.data?.ev ?? ""}`).join(" | ")}]`);
  assert(httpSigOf(dmItems) === JSON.stringify(SIGNATURE), "HTTP DM signature is human bubble -> working row -> bot bubble");
  assert(
    dmItems[0].data?.author?.type === "human" && dmItems[0].data?.text === "私聊里直接问一句",
    "the human line lands verbatim",
  );
  assert(
    dmItems[2].data?.author?.type === "bot" && dmItems[2].data?.author?.id === "leader",
    "the reply bubble is authored by the DM bot",
  );

  /* 6) multi-turn: the second line appends the same three-piece */
  await postJson("/api/groups/dm-leader/send", { text: "再聊一句", author: { type: "human", id: "u1", name: "我" } });
  await waitFor(async () => {
    const items = await itemsOf("dm-leader");
    return items.filter((i) => i.kind === "chat.message" && i.data?.author?.type === "bot").length === 2;
  }, 30000, "the second HTTP DM reply");
  dmItems = await itemsOf("dm-leader");
  assert(
    dmItems.length === 6 && httpSigOf(dmItems) === JSON.stringify([...SIGNATURE, ...SIGNATURE]),
    `the second round appends the same signature in order [${dmItems.map((i) => `${i.kind}:${i.data?.ev ?? i.data?.text ?? ""}`).join(" | ")}]`,
  );

  /* 7) regression: the same task text in a normal group still plans and delivers */
  await postJson(`/api/groups/${normalId}/send`, { text: TASK, author: { type: "human", id: "u1", name: "我" } });
  await waitFor(async () => {
    const events = (await itemsOf(normalId)).filter((i) => i.kind === "work.event").map((i) => i.data);
    return events.some((e) => e.ev === "planning");
  }, 30000, "leader planning in the normal group");
  await waitFor(async () => {
    const events = (await itemsOf(normalId)).filter((i) => i.kind === "work.event").map((i) => i.data);
    return events.some((e) => e.ev === "delivered") && events.some((e) => e.ev === "done");
  }, 30000, "the normal group's delivery");
  const evs = (await itemsOf(normalId)).filter((i) => i.kind === "work.event").map((i) => i.data?.ev);
  const indexOfEv = (ev) => evs.indexOf(ev);
  assert(evs.includes("plan"), `the normal group still shows the plan card [${evs.join(", ")}]`);
  assert(
    indexOfEv("planning") < indexOfEv("delivered") && indexOfEv("delivered") < indexOfEv("done"),
    "the normal group still flows planning -> delivered -> done",
  );
  console.log("normal events :", evs.join(", "));
} finally {
  child.kill();
  for (const suffix of ["", "-wal", "-shm"]) await rm(TMP_DB + suffix, { force: true });
}

console.log("DM ACCEPTANCE OK");
process.exit(0);
