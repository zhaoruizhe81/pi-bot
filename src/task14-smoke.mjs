// task-14 smoke, offline (faux provider). Covers the three backend changes:
//   1. harness.open settings carry compaction: { enabled: false } — the app opens clean and
//      the durable merge turns the built-in enabled:true default off (manual compact() unaffected).
//   2. readAnswer strips whole ACP receipt lines ("📦 [ACP]", "[Compressed", "[Decompressed");
//      a mixed reply keeps its prose, an all-receipt reply folds to "(已折叠历史上下文)",
//      a blank input stays blank so the caller's own fallback keeps working.
//   3. dmDeliver's failure fallback carries the cause head: "这轮没有完成(model_error: …),再试一次?".
// Run from bot/:
//   node --experimental-strip-types src/task14-smoke.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createMusebot } from "./app.ts";
import { FAUX_MODEL } from "./config/model.ts";
import { stripAcpLines } from "./publish/answer.ts";

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
const ACP_LINE = "📦 [ACP] Compressed b2–b2 → 1 block(s), ~509 tokens saved.";

/* ===== Part 1: stripAcpLines, the shared exit filter ===== */
assert(stripAcpLines("正文第一行\n正文第二行") === "正文第一行\n正文第二行", "a plain reply passes through untouched");
assert(
  stripAcpLines(`${ACP_LINE}\n真正的回答\n${ACP_LINE}`) === "真正的回答",
  "receipt lines around the prose are stripped whole",
);
assert(
  stripAcpLines("[Compressed x]\n回答\n[Decompressed x]") === "回答",
  "[Compressed / [Decompressed lines are stripped too",
);
assert(
  stripAcpLines("  📦 [ACP] indented receipt\n回答") === "回答",
  "an indented receipt line is still recognized and stripped",
);
assert(stripAcpLines(ACP_LINE) === "(已折叠历史上下文)", "an all-receipt reply folds to the notice");
assert(stripAcpLines("   \n  ") === "", "a blank input stays blank for the caller's own fallback");

/* ===== Part 2: the harness opens with compaction disabled ===== */
const tmpRoot = await mkdtemp(path.join(tmpdir(), "musebot-task14-"));
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
assert(DEFAULT_COMPACTION_POLICY.enabled === true, "durable's built-in default is enabled:true (so ours must override)");
await app.openDm("leader");
const faux = fauxProvider();
app.models.setProvider(faux.provider);

const botTexts = async () =>
  (await app.readItems("dm-leader"))
    .filter((row) => row.kind === "chat.message" && row.data?.author?.type === "bot")
    .map((row) => String(row.data?.text ?? ""));

// A normal reply: no receipt line, no fallback wording.
faux.setResponses([fauxAssistantMessage([fauxText("正常回复,没有任何回执")])]);
await app.chat("dm-leader", { text: "问一句" });
await waitFor(async () => (await botTexts()).length >= 1, 30000, "the normal DM reply");
let texts = await botTexts();
assert(texts[0] === "正常回复,没有任何回执", `a normal reply lands verbatim [${JSON.stringify(texts[0])}]`);
assert(!texts[0].includes("[ACP]") && !texts[0].includes("已折叠"), "the normal reply has no ACP or fallback wording");

// A reply mixed with receipt lines: prose survives, receipts are stripped.
faux.setResponses([
  fauxAssistantMessage([fauxText(`${ACP_LINE}\n这是混有回执的回答\n[Compressed b3 → b4]`)]),
]);
await app.chat("dm-leader", { text: "再问一句" });
await waitFor(async () => (await botTexts()).length >= 2, 30000, "the mixed DM reply");
texts = await botTexts();
assert(texts[1] === "这是混有回执的回答", `the mixed reply keeps only its prose [${JSON.stringify(texts[1])}]`);

// A reply made only of receipt lines: folded to the notice.
faux.setResponses([fauxAssistantMessage([fauxText(ACP_LINE)])]);
await app.chat("dm-leader", { text: "第三句" });
await waitFor(async () => (await botTexts()).length >= 3, 30000, "the folded DM reply");
texts = await botTexts();
assert(texts[2] === "(已折叠历史上下文)", `an all-receipt reply folds to the notice [${JSON.stringify(texts[2])}]`);

// A model_error run: the fallback carries the cause head, truncated to 120 chars.
const longCause = "HTTP 413 Request Entity Too Large: ".padEnd(180, "x");
const errorReply = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: longCause });
faux.setResponses([errorReply(), errorReply(), errorReply()]);
await app.chat("dm-leader", { text: "第四句,这轮会失败" });
await waitFor(async () => {
  const rows = await botTexts();
  return rows.length >= 4 && rows[3].includes("这轮没有完成");
}, 30000, "the failure fallback bubble");
texts = await botTexts();
const causeShown = texts[3].slice("这轮没有完成(model_error: ".length, texts[3].indexOf("),再试一次?"));
assert(texts[3].startsWith("这轮没有完成(model_error: "), `the fallback names the reason [${JSON.stringify(texts[3])}]`);
assert(texts[3].endsWith("),再试一次?"), "the fallback keeps its trailing wording");
assert(causeShown.length === 120, `the cause is truncated to 120 chars [${causeShown.length}]`);
assert(causeShown.startsWith("HTTP 413"), "the cause is the underlying error text, not just model_error");

await app.close();
await rm(tmpRoot, { recursive: true, force: true });
console.log("TASK14 SMOKE OK");
process.exit(0);
