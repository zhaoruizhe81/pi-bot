// User-created bots. Built-ins come from config/bots.ts; these live in the database,
// so a bot someone creates survives a restart and can join any group.
import { BotDirectory, CustomBot } from "./docs.ts";

const newBotId = () => `cb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** One capability keeps the leader prompt readable: a bot is "the research one", not a swiss army knife. */
export const BOT_CAPABILITIES = ["finance", "data", "analysis", "design", "general"];

export function createCustomBotStore(harness) {
  const cache = new Map();
  let ids = [];

  async function load(ctx) {
    const dir = await harness.snapshot(BotDirectory, ctx);
    ids = [...(dir?.ids ?? [])];
    cache.clear();
    for (const id of ids) {
      const doc = await harness.snapshot(CustomBot, id, ctx);
      if (doc) cache.set(id, doc);
    }
  }

  const toConfig = (doc) => ({
    id: doc.id,
    name: doc.name,
    role: "worker",
    capabilities: [...(doc.capabilities ?? [])],
    avatar: doc.avatar ?? "",
    custom: true,
    agent: {
      // The composition root overwrites this with the live model before the bot runs.
      model: { provider: "faux", modelId: "faux-1" },
      instructions: doc.instructions ?? "",
    },
  });

  return {
    load,
    list() {
      return [...cache.values()].sort((a, b) => a.createdAt - b.createdAt).map(toConfig);
    },
    get(id) {
      return cache.get(id);
    },
    async create(input, ctx) {
      const name = String(input?.name ?? "").trim();
      if (!name) throw new Error("name is required");
      if (name.length > 24) throw new Error("name is too long (max 24)");
      if ([...cache.values()].some((bot) => bot.name === name)) throw new Error(`bot name already exists: ${name}`);
      const capability = String(input?.capability ?? "general").trim();
      if (!BOT_CAPABILITIES.includes(capability)) throw new Error(`unknown capability: ${capability}`);
      const instructions = String(input?.instructions ?? "").trim();
      if (instructions.length > 4000) throw new Error("instructions is too long (max 4000)");
      const avatar = String(input?.avatar ?? "").trim().slice(0, 8);
      const id = newBotId();
      const createdAt = Date.now();
      const doc = { id, name, role: "worker", capabilities: [capability], avatar, instructions, createdAt, updatedAt: createdAt };
      await harness.commit(async (tx) => {
        await tx.doc(CustomBot, id, doc);
        const dir = await tx.doc(BotDirectory);
        if (!dir.ids.includes(id)) dir.ids.push(id);
        return null;
      }, ctx);
      cache.set(id, doc);
      ids.push(id);
      return toConfig(doc);
    },
  };
}
