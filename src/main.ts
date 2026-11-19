import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createMusebot } from "./app.ts";
import { startServer } from "./server/httpWs.ts";
import { readModelConfig, FAUX_MODEL } from "./config/model.ts";

const botDir = fileURLToPath(new URL("../", import.meta.url));
const dbFile = process.env.MUSEBOT_DB ?? path.join(botDir, "data", "musebot.sqlite");
const useFaux = process.env.MUSEBOT_FAUX === "1";
const readOnly = process.env.MUSEBOT_READONLY === "1";
const gateway = readModelConfig();

const port = Number(process.env.PORT ?? 18800);

const app = await createMusebot(
  {
    storageFile: dbFile,
    model: useFaux ? FAUX_MODEL : { provider: gateway.provider, modelId: gateway.modelId },
    gateway,
    // Only pads the faux provider; a real model runs at its own speed.
    workDelayMs: Number(process.env.MUSEBOT_DELAY ?? 0),
    retryMs: Number(process.env.MUSEBOT_RETRY ?? 500),
    readOnly,
    port,
    // Deliverables outlive the bot's scratch dir; a deployment points this at a volume.
    archiveRoot: process.env.MUSEBOT_ARCHIVE ?? undefined,
    uploadRoot: process.env.MUSEBOT_UPLOADS ?? undefined,
    // A viewer process only sees another process' groups by polling.
    groupPollMs: Number(process.env.MUSEBOT_GROUP_POLL ?? (readOnly ? 3000 : 0)),
  },
  ctx,
);

// The Vue build is the primary UI; if it has not been built yet the server falls back to
// the zero-build legacy client so it never answers with a 500.
const staticDir = path.join(botDir, "webui", "dist");
const fallbackStaticDir = path.join(botDir, "web");
const groups = await app.listGroups();
// The bind address is a saved setting (127.0.0.1 by default); a change needs a restart.
const network = await app.network();
const host = network.host;

await startServer(
  { port, staticDir, fallbackStaticDir, readOnly, host },
  {
    groups: app.listGroups,
    openDm: app.openDm,
    createGroup: async (name) => {
      const runtime = await app.ensureGroup({ name });
      return { id: runtime.groupId, name: runtime.doc.name, roster: [...runtime.doc.roster], createdAt: runtime.doc.createdAt };
    },
    items: app.items,
    groupDetail: app.groupDetail,
    botProfile: app.botProfile,
    updateBotProfile: app.updateBotProfile,
    getMemory: app.getMemory,
    addMemory: app.addMemory,
    removeMemory: app.removeMemory,
    setMemoryEnabled: app.setMemoryEnabled,
    clearMemory: app.clearMemory,
    listSkills: app.listSkills,
    setBotSkill: app.setBotSkill,
    network: app.network,
    updateNetwork: app.updateNetwork,
    enableServe: app.enableServe,
    disableServe: app.disableServe,
    getSettings: app.getSettings,
    updateSettings: app.updateSettings,
    checkSettings: app.checkSettings,
    status: app.status,
    bots: app.botsList,
    botCapabilities: app.botCapabilities,
    createBot: app.createBot,
    getProfile: app.getProfile,
    updateProfile: app.updateProfile,
    fileFor: app.fileFor,
    exportGroup: app.exportGroup,
    setAnnouncement: app.setAnnouncement,
    addPin: app.addPin,
    removePin: app.removePin,
    cancel: app.cancel,
    renameGroup: app.renameGroup,
    addMember: app.addMember,
    removeMember: app.removeMember,
    watchGroup: app.watchGroup,
    watchGroups: app.watchGroups,
    imInbound: app.imInbound,
    imOutbox: app.imOutbox,
    imConfig: app.imConfig,
    imRotate: app.imRotate,
    imUpdate: app.imUpdate,
    sendFile: app.sendFile,
    uploadFile: app.uploadFile,
    submit: (groupId, frame) =>
      frame.type === "send"
        ? app.chat(groupId, { text: frame.text, author: frame.author, at: frame.at })
        : app.requirement(groupId, frame.text),
  },
);

console.log(`musebot listening on http://${host}:${port}${host === "0.0.0.0" ? " (all interfaces)" : ""}`);
if (host === "0.0.0.0") {
  for (const entry of network.lan) console.log(`  lan: http://${entry.address}:${port} (${entry.iface})`);
  if (network.tailscale?.ready) {
    for (const ip of network.tailscale.ips) console.log(`  tailnet: http://${ip}:${port}`);
  }
}
console.log(`storage: ${dbFile}`);
console.log(`mode: ${readOnly ? "read-only viewer" : "writer"}`);
console.log(
  useFaux
    ? "model: faux (offline)"
    : `model: ${gateway.provider}/${gateway.modelId} ← ${gateway.baseUrl}`,
);
console.log(`groups: ${groups.map((group) => `${group.id}(${group.name})`).join(", ") || "(none)"}`);
