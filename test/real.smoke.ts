// Real-model smoke: one requirement through the live gateway, real answers in the group.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createMusebot } from "../src/app.ts";
import { readModelConfig } from "../src/config/model.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gateway = readModelConfig();
const dir = await mkdtemp(path.join(os.tmpdir(), "musebot-real-"));
const dbFile = path.join(dir, "musebot.sqlite");

const app = await createMusebot(
  {
    storageFile: dbFile,
    model: { provider: gateway.provider, modelId: gateway.modelId },
    gateway,
    workDelayMs: 0,
    retryMs: 100,
    workspaceRoot: path.join(dir, "workspace"),
  },
  ctx,
);
const [group] = await app.listGroups();
const t0 = Date.now();
await app.requirement(group.id, "写一份 Q3 财报要点,保存成 report.md 交付");
const deadline = Date.now() + 300_000;
let rows = [];
while (Date.now() < deadline) {
  rows = await app.graph.list(group.id, ctx);
  if (rows.length > 0 && rows.every((r) => ["done", "failed", "cancelled"].includes(r.status))) break;
  await sleep(500);
}
console.log("elapsed ms :", Date.now() - t0);
console.log("work       :", rows.map((r) => `${r.key}:${r.status}@${r.assignee}`).join(" "));
console.log("subjects   :", rows.map((r) => `${r.key}=${r.subject}`).join(" | "));
console.log("reasons    :", rows.filter((r) => r.blockedReason).map((r) => `${r.key}:${r.blockedReason}`).join(" | ") || "-");

const bodies = [];
for (const row of rows) {
  if (!row.artifactId) continue;
  const artifact = await app.artifacts.get(row.artifactId, ctx);
  bodies.push({
    key: row.key,
    bot: row.assignee,
    chars: artifact?.body?.length ?? 0,
    files: (artifact?.files ?? []).map((file) => `${file.path}(${file.bytes}B)`).join(","),
    head: artifact?.body?.slice(0, 80),
  });
}
console.table(bodies);
const withText = bodies.filter((b) => b.chars > 20);
if (withText.length === 0) throw new Error("no real answer text reached the group");

await app.close();
await rm(dir, { recursive: true, force: true });
console.log("REAL SMOKE OK");
