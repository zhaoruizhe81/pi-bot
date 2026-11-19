import type { BotConfig, BotId, Capability } from "../protocol/types.ts";

/** Pure in-memory config lookup: no durable I/O, so no Context. */
export function createBotRegistry(bots) {
  const byId = new Map(bots.map((b) => [b.id, b]));
  return {
    get: (id) => byId.get(id),
    all: () => [...bots],
    byCapability: (cap) => bots.filter((b) => b.capabilities.includes(cap)),
    leader: () => bots.find((b) => b.role === "leader"),
    /** A bot created at runtime joins the same array the planner and pickers read. */
    add: (bot) => {
      if (byId.has(bot.id)) return;
      bots.push(bot);
      byId.set(bot.id, bot);
    },
  };
}
