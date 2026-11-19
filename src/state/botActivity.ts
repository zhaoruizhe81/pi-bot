import { LiveDoc } from "@earendil-works/pi-durable";

/** Busy = the bot conversation's LiveDoc.run is present (pi-durable guarantees it while running). */
export function createBotActivity(harness, registry, conversationIdFor, isMember = () => true) {
  const live = async (botId, ctx) => {
    const conversationId = conversationIdFor(botId);
    // A bot that left the group has no conversation here; it can neither be busy nor be chosen.
    if (!conversationId) return undefined;
    return await harness.snapshot(LiveDoc, conversationId, ctx);
  };
  return {
    async isBusy(botId, ctx) {
      const v = await live(botId, ctx);
      return !!(v && v.run);
    },
    async chooseIdle(capability, ctx) {
      for (const bot of registry.byCapability(capability)) {
        if (!isMember(bot.id)) continue;
        const v = await live(bot.id, ctx);
        if (!(v && v.run)) return bot.id;
      }
      return undefined;
    },
    has(botId) {
      return isMember(botId);
    },
  };
}
