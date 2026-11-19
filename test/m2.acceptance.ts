// M2 acceptance: SQLite persistence (groups, conversations, work graph, pins, artifacts
// survive a restart) and group isolation (separate bot conversations, separate blackboards).
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LiveDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createMusebot } from "../src/app.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const terminal = (rows) =>
  rows.length > 0 && rows.every((row) => ["done", "failed", "cancelled"].includes(row.status));

const dir = await mkdtemp(path.join(os.tmpdir(), "musebot-m2-"));
const dbFile = path.join(dir, "musebot.sqlite");
const opts = { storageFile: dbFile, workDelayMs: 25, retryMs: 10 };
const log = (...args) => console.log(...args);

/* ---------------- first run: two groups, both busy at once ---------------- */

let app = await createMusebot(opts, ctx);
const seeded = (await app.listGroups())[0];
const secondRuntime = await app.ensureGroup({ name: "运营群" });
let groups = await app.listGroups();
assert(groups.length === 2, `expected 2 groups, got ${groups.length}`);
log("groups        :", groups.map((g) => `${g.id}(${g.name})`).join(", "));

const g1 = groups.find((g) => g.id === seeded.id);
const g2 = groups.find((g) => g.id === secondRuntime.groupId);
const rt1 = app.group(g1.id);
const rt2 = app.group(g2.id);

const convs = (runtime) => Object.fromEntries(runtime.doc.roster.map((botId) => [botId, runtime.conversationIdFor(botId)]));
const convs1 = convs(rt1);
const convs2 = convs(rt2);
for (const botId of Object.keys(convs1)) {
  assert(convs1[botId] !== convs2[botId], `bot ${botId} shares one conversation across groups`);
}
assert(rt1.groupConversationId !== rt2.groupConversationId, "groups share a blackboard");
log("g1 convs      :", rt1.groupConversationId, "bot[finance]", convs1.finance);
log("g2 convs      :", rt2.groupConversationId, "bot[finance]", convs2.finance);

const t0 = Date.now();
await Promise.all([app.requirement(g1.id, "出季度财报"), app.requirement(g2.id, "做一份增长分析")]);
const submitMs = Date.now() - t0;
log("two submits ms:", submitMs);
assert(submitMs < 2000, `cross-group submit blocked for ${submitMs}ms`);

await app.send(g1.id, { text: "g1 专属消息" });
await app.send(g2.id, { text: "g2 专属消息" });

const deadline = Date.now() + 30000;
let rows1 = [];
let rows2 = [];
while (Date.now() < deadline) {
  rows1 = await app.graph.list(g1.id, ctx);
  rows2 = await app.graph.list(g2.id, ctx);
  if (terminal(rows1) && terminal(rows2)) break;
  await sleep(50);
}
log("g1 work       :", rows1.map((r) => `${r.key}:${r.status}@${r.assignee ?? "-"}`).join(" "));
log("g2 work       :", rows2.map((r) => `${r.key}:${r.status}@${r.assignee ?? "-"}`).join(" "));
assert(rows1.length === 4 && rows2.length === 4, "each group should hold its own 4 work items");
assert(rows1.every((r) => r.status === "done"), `g1 not all done: ${rows1.map((r) => r.status)}`);
assert(rows2.every((r) => r.status === "done"), `g2 not all done: ${rows2.map((r) => r.status)}`);

const artifact = await app.artifacts.get(rows1[0].artifactId, ctx);
assert(artifact && artifact.title === rows1[0].subject, "artifact missing for a done work item");
log("artifact      :", artifact.id, artifact.title);

const blackboardLive = await app.harness.snapshot(LiveDoc, rt1.groupConversationId, ctx);
assert(!blackboardLive?.run, "the group blackboard started a model run");

await app.groupStore.setAnnouncement(g2.id, "本群只看增长指标", ctx);
await app.groupStore.addPin(g2.id, { text: "周报周五 18:00 前交", by: "u1" }, ctx);
const pin = await app.groupStore.pin(g2.id, ctx);
assert(pin.announcement === "本群只看增长指标" && pin.pins.length === 1, "pin did not stick");

// A user-created bot and the personal profile are durable too, not process state.
const customBot = await app.createBot({
  name: "兼职bot",
  capability: "general",
  instructions: "你负责临时调研。",
  avatar: "🧪",
});
await app.updateProfile({ name: "阿哲", signature: "持久化测试", avatar: "" });
await app.updateBotProfile(g1.id, "design", { name: "设计官", avatar: "🎨" });

const before = {
  groups: groups.map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt, roster: [...g.roster] })),
  blackboards: { [g1.id]: rt1.groupConversationId, [g2.id]: rt2.groupConversationId },
  botConvs: { [g1.id]: convs1, [g2.id]: convs2 },
  chats: {
    [g1.id]: (await app.readItems(g1.id)).filter((i) => i.kind === "chat.message").map((i) => i.data.text),
    [g2.id]: (await app.readItems(g2.id)).filter((i) => i.kind === "chat.message").map((i) => i.data.text),
  },
  items: { [g1.id]: (await app.readItems(g1.id)).length, [g2.id]: (await app.readItems(g2.id)).length },
};
assert(before.chats[g1.id].includes("g1 专属消息") && !before.chats[g1.id].includes("g2 专属消息"), "blackboards leaked");
assert(before.chats[g2.id].includes("g2 专属消息"), "g2 message missing");
await app.close();

/* ---------------- second run: same database, nothing recreated ---------------- */

const tReopen = Date.now();
app = await createMusebot(opts, ctx);
const reopenMs = Date.now() - tReopen;
groups = await app.listGroups();
log("reopen ms     :", reopenMs);
log("groups after  :", groups.map((g) => `${g.id}(${g.name})`).join(", "));

assert(groups.length === 2, `reopen created/lost groups: ${groups.length}`);
for (const expected of before.groups) {
  const actual = groups.find((g) => g.id === expected.id);
  assert(actual && actual.name === expected.name, `group ${expected.id} changed across restart`);
  assert(actual.roster.join() === expected.roster.join(), `roster of ${expected.id} changed across restart`);
}

assert(
  app.botsList().some((bot) => bot.id === customBot.bot.id && bot.custom === true),
  "custom bot did not survive restart",
);
assert(
  app.botRegistry.get(customBot.bot.id)?.agent.instructions === "你负责临时调研。",
  "custom bot instructions did not survive restart",
);
assert((await app.getProfile()).name === "阿哲", "profile did not survive restart");
assert(
  app.botsList().some((bot) => bot.id === "design" && bot.name === "设计官" && bot.avatar === "🎨"),
  "bot identity did not survive restart",
);
log("profile/bots  :", `${customBot.bot.name} + 阿哲 survived`);

for (const [groupId, conversationId] of Object.entries(before.blackboards)) {
  assert(app.group(groupId).groupConversationId === conversationId, `blackboard of ${groupId} was recreated`);
}
for (const [groupId, perBot] of Object.entries(before.botConvs)) {
  for (const [botId, conversationId] of Object.entries(perBot)) {
    assert(app.group(groupId).conversationIdFor(botId) === conversationId, `${groupId}/${botId} conversation was recreated`);
  }
}

const afterRows1 = await app.graph.list(g1.id, ctx);
const afterRows2 = await app.graph.list(g2.id, ctx);
log("work after    :", `${afterRows1.filter((r) => r.status === "done").length}/4 + ${afterRows2.filter((r) => r.status === "done").length}/4`);
assert(afterRows1.every((r) => r.status === "done") && afterRows2.every((r) => r.status === "done"), "work status lost");

for (const groupId of [g1.id, g2.id]) {
  const items = await app.readItems(groupId);
  assert(items.length === before.items[groupId], `entry count changed for ${groupId}`);
}
const chatsAfter = (await app.readItems(g1.id)).filter((i) => i.kind === "chat.message").map((i) => i.data.text);
assert(chatsAfter.includes("g1 专属消息"), "chat history lost");

const artifactAfter = await app.artifacts.get(rows1[0].artifactId, ctx);
assert(artifactAfter && artifactAfter.title === rows1[0].subject, "artifact lost across restart");
const pinAfter = await app.groupStore.pin(g2.id, ctx);
assert(pinAfter.announcement === "本群只看增长指标" && pinAfter.pins.length === 1, "pins lost across restart");

// A new message in the restored group still works, on the same conversation.
await app.send(g1.id, { text: "重启后还能说话" });
const finalChats = (await app.readItems(g1.id)).filter((i) => i.kind === "chat.message").map((i) => i.data.text);
assert(finalChats[finalChats.length - 1] === "重启后还能说话", "restored blackboard is not writable");

await app.close();
await rm(dir, { recursive: true, force: true });
console.log("M2 ACCEPTANCE OK");
