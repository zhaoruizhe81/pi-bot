// Product features: cancel one work item, add/remove group members, paginated history.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createMusebot } from "../src/app.ts";
import { createGroupPinSection } from "../src/execution/groupContext.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const waitFor = async (test, timeoutMs = 20000, label = "condition") => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const app = await createMusebot({ storageFile: ":memory:", workDelayMs: 250, retryMs: 100 }, ctx);
const [group] = await app.listGroups();

/* ---------- pagination ---------- */
for (let i = 1; i <= 12; i += 1) await app.send(group.id, { text: `历史消息 ${i}` });
const page1 = await app.items(group.id, { limit: 5 });
assert(page1.items.length === 5, `page1 should hold 5 entries, got ${page1.items.length}`);
assert(page1.next, "page1 must carry a cursor");
const page2 = await app.items(group.id, { limit: 5, before: page1.next });
const ids1 = new Set(page1.items.map((item) => item.id));
assert(page2.items.every((item) => !ids1.has(item.id)), "pages overlap");
const firstChat = page2.items.find((item) => item.kind === "chat.message");
assert(firstChat, "page2 should contain older chat entries");
console.log("pagination    :", `page1=${page1.items.length} page2=${page2.items.length} next=${!!page2.next}`);

/* ---------- cancel one work item ---------- */
await app.requirement(group.id, "出季度财报");
await waitFor(async () => (await app.graph.list(group.id, ctx)).length > 0, 20000, "plan");
const design = (await app.graph.list(group.id, ctx)).find((row) => row.capability === "design");
assert(design, "plan should include a design task");
const cancelled = await app.cancel(group.id, design.id);
console.log("cancel        :", JSON.stringify(cancelled));
await waitFor(
  async () => (await app.graph.list(group.id, ctx)).find((row) => row.id === design.id)?.status === "cancelled",
  20000,
  "cancelled status",
);
const events = (await app.readItems(group.id)).filter((item) => item.kind === "work.event").map((item) => item.data);
assert(events.some((event) => event.ev === "cancelled" && event.workId === design.id), "cancelled card missing");
const again = await app.cancel(group.id, design.id);
assert(again.status === "terminal", `second cancel should report terminal, got ${again.status}`);
console.log("cancel card   :", events.filter((event) => event.ev === "cancelled").length, "| second cancel:", again.status);

/* ---------- members ---------- */
await waitFor(async () => !(await app.group(group.id).activity.isBusy("design", ctx)), 20000, "design idle");
const before = app.group(group.id);
const designConversation = before.conversationIdFor("design");
assert(designConversation, "design should start in the group");
const removed = await app.removeMember(group.id, "design");
assert(removed.removed, "remove should report removed");
assert(!app.group(group.id).conversationIdFor("design"), "runtime kept a removed member");
assert(
  (await app.listGroups()).find((candidate) => candidate.id === group.id).roster.includes("design") === false,
  "roster still lists the removed bot",
);
const added = await app.addMember(group.id, "design");
assert(!added.already, "re-add should not be a no-op");
assert(app.group(group.id).conversationIdFor("design") === designConversation, "re-add minted a new conversation");
console.log("members       :", `removed=${removed.removed} readd=${!added.already} conv=${designConversation}`);

let busyRejected = false;
try {
  await app.addMember(group.id, "nobody");
} catch {
  busyRejected = true;
}
assert(busyRejected, "unknown bot must be rejected");
console.log("validation    : unknown bot rejected");

/* ---------- shared group context: announcement + pins ---------- */
const frames = [];
const offDetail = await app.watchGroup(group.id, (frame) => frames.push(frame));
const withContext = await app.setAnnouncement(group.id, "对外统一用 Q3 财报口径");
assert(withContext.announcement.includes("Q3"), "announcement not saved");
const pinned = await app.addPin(group.id, { text: "所有数字保留两位小数", by: "我" });
assert(pinned.pins.length === 1, `expected 1 pin, got ${pinned.pins.length}`);
await waitFor(
  () => frames.some((frame) => frame.type === "detail" && (frame.detail?.pins ?? []).length === 1),
  5000,
  "detail push",
);
// The shared context must reach the bots: it renders into every bot's prompt section.
const renderContext = createGroupPinSection({
  groupIdFor: () => group.id,
  pin: (groupId, context) => app.groupStore.pin(groupId, context),
});
const contextText = await renderContext.render({ conversationId: app.group(group.id).groupConversationId }, ctx);
assert(String(contextText).includes("Q3 财报口径"), "announcement missing from the bot prompt");
assert(String(contextText).includes("保留两位小数"), "pin missing from the bot prompt");
const unpinned = await app.removePin(group.id, pinned.pins[0].id);
assert(unpinned.pins.length === 0, "pin not removed");
let emptyPinRejected = false;
try {
  await app.addPin(group.id, { text: "   " });
} catch {
  emptyPinRejected = true;
}
assert(emptyPinRejected, "empty pin must be rejected");
offDetail();
console.log("group context :", `announcement+pin in prompt, detail frames=${frames.filter((frame) => frame.type === "detail").length}`);

/* ---------- files: archive survives the next dispatch, export covers history ---------- */
const designerConv = app.group(group.id).conversationIdFor("design");
assert(designerConv, "design conversation should exist");
await app.group(group.id).workspace.write(designerConv, "reports/q3.md", "# Q3\n收入 12,480 万");
await app.group(group.id).workspace.write(designerConv, "charts.csv", "month,value\n7,12480");
const archived = await app.group(group.id).workspace.archive(group.id, "w-test-1", designerConv);
assert(archived.length === 2, `expected 2 archived files, got ${archived.length}`);
// The next dispatch resets scratch; the archive must not care.
await app.group(group.id).workspace.reset(designerConv);
assert((await app.group(group.id).workspace.list(designerConv)).length === 0, "scratch should be empty after reset");
const stillThere = await app.group(group.id).workspace.listArchive(group.id, "w-test-1");
assert(stillThere.length === 2, "archive lost files when scratch was reset");
const readBack = await app.group(group.id).workspace.readArchive(group.id, "w-test-1", "reports/q3.md");
assert(readBack.buffer.toString("utf8").includes("12,480"), "archived content changed");
let traversalRejected = false;
try {
  await app.group(group.id).workspace.readArchive(group.id, "w-test-1", "../../etc/passwd");
} catch {
  traversalRejected = true;
}
assert(traversalRejected, "traversal into the archive must be rejected");
console.log("files         :", `archived=${archived.length} survives-reset=true traversal-blocked=true`);

/* ---------- rename: the panel edits the group name ---------- */
const renamed = await app.renameGroup(group.id, "产品研发群(改名测试)");
assert(renamed.group.name === "产品研发群(改名测试)", `rename did not stick: ${renamed.group.name}`);
assert(
  (await app.listGroups()).find((row) => row.id === group.id)?.name === "产品研发群(改名测试)",
  "group list still shows the old name",
);
let badName = false;
try {
  await app.renameGroup(group.id, "   ");
} catch {
  badName = true;
}
assert(badName, "empty group name must be rejected");
await app.renameGroup(group.id, "产品研发群");
console.log("rename        :", "round-trip ok, empty rejected");

const exported = await app.exportGroup(group.id, "md");
assert(/"|\n/.test(exported.content), "export should be text");
assert(exported.content.includes("Q3 财报口径"), "export should contain the announcement");
assert(exported.content.includes("历史消息 1"), "export should contain old chat lines");
assert(exported.filename.endsWith(".md"), `unexpected filename ${exported.filename}`);
const asJson = await app.exportGroup(group.id, "json");
const parsed = JSON.parse(asJson.content);
assert(Array.isArray(parsed.items) && parsed.items.length > 0, "json export should carry items");
console.log("export        :", `${exported.filename} md=${exported.content.length}B json=${parsed.items.length} items`);

/* ---------- IM bridge: token-auth inbound, same router, outbox pull ---------- */
const im = await app.imConfig(group.id);
assert(im.tokenSet && im.tokenMask.includes("…"), "IM config starts with a masked token");
const rotated = await app.imRotate(group.id);
assert(rotated.token && rotated.token.startsWith("imb_"), "rotate returns the full token once");
const imToken = rotated.token;

const chatRoute = await app.imInbound(group.id, imToken, { sender: "IM张三", text: "收到,我下午看" });
assert(chatRoute.routed === "chat", "a chat line from IM stays chat");
const reqRoute = await app.imInbound(group.id, imToken, { sender: "IM李四", text: "帮我整理一版客服周报" });
assert(reqRoute.routed === "requirement", "a requirement from IM reaches the leader");
const imItems = await app.readItems(group.id);
assert(
  imItems.some((item) => item.kind === "chat.message" && item.data.text === "收到,我下午看" && item.data.author.name === "IM张三"),
  "IM message lands with the sender name",
);
let badToken = false;
try {
  await app.imInbound(group.id, "nope", { text: "x" });
} catch {
  badToken = true;
}
assert(badToken, "a wrong IM token is rejected");
await app.imUpdate(group.id, { enabled: false });
let disabledRejected = false;
try {
  await app.imInbound(group.id, imToken, { text: "x" });
} catch {
  disabledRejected = true;
}
assert(disabledRejected, "a disabled bridge rejects inbound");
await app.imUpdate(group.id, { enabled: true });
const outbox = await app.imOutbox(group.id, imToken, 0);
assert(outbox.items.length > 0, "outbox returns group entries");
assert(outbox.next >= outbox.items[outbox.items.length - 1].id, "outbox cursor is monotonic");
console.log("im bridge     :", `${outbox.items.length} entries pullable, wrong token/disabled rejected`);

/* ---------- composer uploads: file / image / voice land as chat.file ---------- */
const upload = await app.sendFile(group.id, {
  name: "验收附件.txt",
  mime: "text/plain",
  data: Buffer.from("composer upload").toString("base64"),
  author: { type: "human", id: "u1", name: "我" },
});
assert(upload.id && upload.bytes === 15, `upload should store 15 bytes, got ${upload.bytes}`);
const uploadedItems = await app.readItems(group.id);
const fileEntry = uploadedItems.filter((item) => item.kind === "chat.file").pop();
assert(fileEntry && fileEntry.data.file.id === upload.id, "chat.file entry carries the upload");
assert(fileEntry.data.author.name === "我", "chat.file keeps the author");
const readBackUpload = await app.uploadFile(group.id, upload.id);
assert(readBackUpload.buffer.toString("utf8") === "composer upload", "uploaded bytes round-trip");
let bigRejected = false;
try {
  await app.sendFile(group.id, { name: "big.bin", mime: "application/octet-stream", data: Buffer.alloc(13 * 1024 * 1024).toString("base64") });
} catch {
  bigRejected = true;
}
assert(bigRejected, "an oversized upload must be rejected");
let traversalRejected2 = false;
try {
  await app.uploadFile(group.id, "../../etc/passwd");
} catch {
  traversalRejected2 = true;
}
assert(traversalRejected2, "upload ids are validated");
console.log("uploads       :", `file=${upload.name} ${upload.bytes}B, size cap + id validation ok`);

/* ---------- per-bot profile: prompt + model override, applied to that conversation ---------- */
const botView = await app.botProfile(group.id, "design");
assert(botView.instructions.effective === botView.instructions.default, "a fresh bot uses its default prompt");
assert(botView.model.effective === (await app.getSettings()).modelId, "a fresh bot follows the global model");
assert(botView.groups.some((row) => row.id === group.id), "profile lists the groups the bot is in");

const overridden = await app.updateBotProfile(group.id, "design", {
  instructions: "你只做排版,输出不超过 3 条要点。",
  model: "",
});
assert(overridden.instructions.override.includes("不超过 3 条"), "prompt override saved");
assert(overridden.instructions.effective === overridden.instructions.override, "override wins over the default");
assert(overridden.model.override === "", "model still follows the global one");

const withModel = await app.updateBotProfile(group.id, "design", { instructions: "", model: "test/model-2" });
assert(withModel.model.override === "test/model-2", "per-bot model saved");
assert(withModel.model.effective === "test/model-2", "per-bot model wins");
assert(withModel.instructions.override === "", "clearing the prompt restores the default");

const botRenamed = await app.updateBotProfile(group.id, "design", { name: "设计官", avatar: "🎨" });
assert(botRenamed.name === "设计官" && botRenamed.avatar === "🎨", "bot name/avatar saved");
assert(app.botsList().some((bot) => bot.id === "design" && bot.name === "设计官"), "bot list uses the new identity");
assert((await app.groupDetail(group.id)).members.some((member) => member.name === "设计官"), "group detail uses the new identity");
await app.updateBotProfile(group.id, "design", { name: "设计bot", avatar: "" });

for (const bad of [{ model: "bad model!" }, { instructions: "x".repeat(4001) }]) {
  let rejected = false;
  try {
    await app.updateBotProfile(group.id, "design", { instructions: "", model: "", ...bad });
  } catch {
    rejected = true;
  }
  assert(rejected, `invalid bot profile must be rejected: ${JSON.stringify(bad).slice(0, 40)}`);
}

const cleared = await app.updateBotProfile(group.id, "design", { instructions: "", model: "" });
assert(cleared.model.override === "" && cleared.instructions.override === "", "clearing removes both overrides");
console.log("bot profile   :", "prompt/model overrides round-trip, validation ok");

/* ---------- network: bind address is persisted and validated ---------- */
const net = await app.network();
assert(net.hosts.includes("127.0.0.1") && net.hosts.includes("0.0.0.0"), "network lists the bind choices");
assert(Array.isArray(net.lan), "network reports lan addresses");
assert(net.tailscale && typeof net.tailscale.installed === "boolean", "tailscale probe answers");
assert(
  net.tailscale.serve && typeof net.tailscale.serve.enabled === "boolean" && Array.isArray(net.tailscale.serve.entries),
  "tailscale serve status is reported",
);
const moved = await app.updateNetwork({ host: "0.0.0.0" });
assert(moved.host === "0.0.0.0" && moved.restartRequired, "bind address saved with a restart hint");
assert((await app.network()).host === "0.0.0.0", "bind address persisted");
for (const bad of ["1.2.3.4", "", "localhost"]) {
  let rejected = false;
  try {
    await app.updateNetwork({ host: bad });
  } catch {
    rejected = true;
  }
  assert(rejected, `invalid host must be rejected: ${JSON.stringify(bad)}`);
}
await app.updateNetwork({ host: "127.0.0.1" });
console.log("network       :", `hosts ok, tailscale=${net.tailscale.installed ? "detected" : "absent"}, validation ok`);

/* ---------- settings: the model endpoint is real and validated ---------- */
const settingsBefore = await app.getSettings();
assert(settingsBefore.modelId, "settings expose the effective model");
assert(settingsBefore.apiKeySet, "settings report that a key exists");
assert(settingsBefore.apiKeyMask?.includes("…"), "the key is masked, never echoed");
assert(Array.isArray(settingsBefore.apis) && settingsBefore.apis.includes("openai-completions"), "api kinds listed");

const settingsSaved = await app.updateSettings({
  api: "openai-completions",
  baseUrl: "http://example.test/v1",
  modelId: "test/model-1",
  apiKey: "",
});
assert(settingsSaved.modelId === "test/model-1", "model id persists");
assert(settingsSaved.baseUrl === "http://example.test/v1", "base url persists");
assert(settingsSaved.apiKeySet, "an empty key field keeps the stored one");
assert(settingsSaved.source === "settings", "source flips to settings after saving");

for (const bad of [{ baseUrl: "ftp://x" }, { modelId: "" }, { api: "nope" }]) {
  let rejected = false;
  try {
    await app.updateSettings({ api: "openai-completions", baseUrl: "http://example.test/v1", modelId: "m", ...bad });
  } catch {
    rejected = true;
  }
  assert(rejected, `invalid settings must be rejected: ${JSON.stringify(bad)}`);
}

const status = await app.status();
assert(status.mode === "writer", "status reports the process mode");
assert(typeof status.groups === "number" && status.groups > 0, "status counts groups");
assert(status.archive && typeof status.archive.files === "number", "status carries archive stats");
assert(status.model.modelId === "test/model-1", "status reflects the saved model");
console.log("settings      :", `model=${status.model.modelId} archive=${status.archive.files} files, validation ok`);

// leave the endpoint as we found it
await app.updateSettings({
  api: settingsBefore.api,
  baseUrl: settingsBefore.baseUrl,
  modelId: settingsBefore.modelId,
  apiKey: "",
});

/* ---------- personal profile: nickname / signature / avatar ---------- */
const profileBefore = await app.getProfile();
assert(profileBefore.name === "我", "profile starts as 我");
const profileSaved = await app.updateProfile({
  name: "阿哲",
  signature: "在写 musebot",
  avatar: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
});
assert(profileSaved.name === "阿哲" && profileSaved.signature === "在写 musebot", "profile round-trips");
assert(profileSaved.avatar.startsWith("data:image/png;base64,"), "avatar stored as a data URL");
assert((await app.getProfile()).name === "阿哲", "profile persists in the document store");
let badAvatar = false;
try {
  await app.updateProfile({ name: "x", signature: "", avatar: "https://example.test/a.png" });
} catch {
  badAvatar = true;
}
assert(badAvatar, "non-data avatar URL must be rejected");
console.log("profile       :", `name=${profileSaved.name} avatar=${profileSaved.avatar.length}B, validation ok`);

/* ---------- create a bot from the UI API and put it to work ---------- */
const caps = app.botCapabilities();
assert(caps.includes("general") && caps.includes("finance"), "capability list is exposed");
const botsBefore = app.botsList().length;
const created = await app.createBot({
  name: "调研bot",
  capability: "general",
  instructions: "你负责用户调研,输出访谈结论。",
  avatar: "🧪",
  groupId: group.id,
});
assert(created.added === true, "new bot joins the group in one call");
assert(app.botsList().length === botsBefore + 1, "bot registry grows");
const createdConfig = app.botRegistry.get(created.bot.id);
assert(createdConfig && createdConfig.custom === true, "custom bot is marked as such");
assert(createdConfig.agent.instructions.includes("用户调研"), "custom instructions are stored");
const groupAfterBot = await app.groupDetail(group.id);
assert(groupAfterBot.members.some((m) => m.id === created.bot.id && m.name === "调研bot"), "group detail lists the new bot");
assert(app.group(group.id).conversationIdFor(created.bot.id), "new bot got its own conversation");
const customBotView = await app.botProfile(group.id, created.bot.id);
assert(customBotView.custom === true && customBotView.avatar === "🧪", "bot panel exposes identity");
let duplicateRejected = false;
try {
  await app.createBot({ name: "调研bot", capability: "general", instructions: "", groupId: group.id });
} catch {
  duplicateRejected = true;
}
assert(duplicateRejected, "duplicate bot name must be rejected");
let badCapability = false;
try {
  await app.createBot({ name: "野bot", capability: "hacking", instructions: "" });
} catch {
  badCapability = true;
}
assert(badCapability, "unknown capability must be rejected");
console.log("create bot    :", `${created.bot.name} (${created.bot.id}) joined=${created.added}, validation ok`);

/* ---------- one input box: chat vs request ---------- */
const chatGroup = await app.ensureGroup({ name: "输入判定群" });
await app.chat(chatGroup.groupId, { text: "谢谢,先这样" });
await sleep(300);
let chatEntries = await app.readItems(chatGroup.groupId);
assert(chatEntries.some((item) => item.kind === "chat.message" && item.data.text === "谢谢,先这样"), "chat line missing");
assert(!chatEntries.some((item) => item.kind === "work.event"), "casual chat must not create work");

await app.chat(chatGroup.groupId, { text: "帮我整理一版客服周报" });
await waitFor(
  async () => (await app.readItems(chatGroup.groupId)).some((item) => item.kind === "work.event"),
  15000,
  "request detection",
);
chatEntries = await app.readItems(chatGroup.groupId);
assert(chatEntries.some((item) => item.kind === "work.event"), "a request should reach the leader");
console.log("chat routing  : chat stays chat, request creates work");

await app.close();
console.log("FEATURES ACCEPTANCE OK");
