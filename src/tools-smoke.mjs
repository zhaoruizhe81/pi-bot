// Tool smoke, offline (faux provider scripts the model's tool calls). Proves the real
// musebot tool kit through durable's own pipeline: write_file → read round-trip, bash
// cwd/echo/timeout, read pagination, binary and traversal rejection, output truncation.
// Run from bot/:
//   node --experimental-strip-types src/tools-smoke.mjs
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { createBashTool, createReadTool } from "./execution/tools.ts";
import { createWriteFileTool } from "./execution/fileTool.ts";
import { createWorkspace } from "./execution/workspace.ts";

const context = BACKGROUND_CONTEXT;
const workspaceRoot = await mkdtemp(path.join(tmpdir(), "musebot-tools-"));
const workspace = createWorkspace(workspaceRoot);

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const toolCall = (name, args, id) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });

const registry = createRegistry();
registry.install(
  defineExtension({
    name: "musebot-tools",
    tools: [createReadTool(workspace), createBashTool(workspace), createWriteFileTool(workspace)],
  }),
);

// Turn 1: write_file → read round-trip. Turn 2: bash pwd/echo/timeout. Turn 3: pagination,
// binary, traversal and truncation edges.
faux.setResponses([
  toolCall("write_file", { path: "hello.txt", content: "你好 musebot\n第二行内容" }, "w1"),
  toolCall("read", { path: "hello.txt" }, "r1"),
  fauxAssistantMessage([fauxText("turn1 done")]),
  toolCall("bash", { command: "pwd" }, "b1"),
  toolCall("bash", { command: "echo hi" }, "b2"),
  toolCall("bash", { command: "sleep 3", timeoutMs: 1000 }, "b3"),
  fauxAssistantMessage([fauxText("turn2 done")]),
  toolCall("write_file", { path: "pages.md", content: Array.from({ length: 40 }, (_, i) => `第${i + 1}行内容`).join("\n") }, "w2"),
  toolCall("read", { path: "pages.md", offset: 35, lines: 3 }, "r2"),
  toolCall("bash", { command: "printf 'a\\000b' > blob.bin" }, "b4"),
  toolCall("read", { path: "blob.bin" }, "r3"),
  toolCall("read", { path: "../escape.txt" }, "r4"),
  toolCall("bash", { command: "yes 0123456789012345678901234567890 | head -c 30000 > big.txt" }, "b5"),
  toolCall("read", { path: "big.txt" }, "r5"),
  fauxAssistantMessage([fauxText("turn3 done")]),
]);

const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

for (const [index, prompt] of ["写个文件再读回来", "跑几条命令", "读大文件和边界"].entries()) {
  const sub = await root.submit({ type: "input", content: prompt }, context);
  const settled = await sub.wait(context);
  if (settled.status !== "done") throw new Error(`turn ${index + 1} did not finish: ${settled.status}`);
}

const transcript = await root.entries({}, 40, undefined, context);
const results = [...transcript.items].reverse().filter((entry) => ToolResultEntry.is(entry));
const textOf = (entry) =>
  (entry.model?.[0]?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("");

const expect = (label, needle, haystack) => {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected ${JSON.stringify(needle)} in ${JSON.stringify(haystack.slice(0, 300))}`);
  }
  console.log(`ok  ${label}`);
};
const byTool = (name) => results.filter((entry) => entry.model?.[0]?.toolName === name);

// write_file's own result entry is the file on disk: the round-trip target read must see both lines.
const dir = workspace.dirFor(root.id);
const hello = await readFile(path.join(dir, "hello.txt"), "utf8");
expect("write_file landed", "你好 musebot\n第二行内容", hello);
expect("read after write_file", "你好 musebot", textOf(byTool("read")[0]));
expect("read after write_file line2", "第二行内容", textOf(byTool("read")[0]));

const bashes = byTool("bash");
expect("bash pwd = workspace dir", dir, textOf(bashes[0]));
expect("bash pwd header", "$ pwd", textOf(bashes[0]));
expect("bash echo hi", "$ echo hi\nhi", textOf(bashes[1]));
expect("bash timeout note", "已被终止(killed)", textOf(bashes[2]));
expect("bash timeout ms", "1000ms", textOf(bashes[2]));

const reads = byTool("read");
expect("read pages window start", "第35行内容", textOf(reads[1]));
expect("read pages window end", "第37行内容", textOf(reads[1]));
expect("read pages next-offset note", "offset=38", textOf(reads[1]));
expect("read binary rejected", "暂不支持二进制", textOf(reads[2]));
expect("read traversal rejected", "escapes the workspace", textOf(reads[3]));
expect("read truncation note", "已截断", textOf(reads[4]));

await harness.close(context);
await rm(workspaceRoot, { recursive: true, force: true });
console.log("TOOLS SMOKE OK");
