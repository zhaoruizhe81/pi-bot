// Per-group overrides for a single bot: a custom prompt (SOUL) and an optional model.
// Empty fields mean "use the bot's configured default", so clearing is just storing "".
import { BotProfile } from "./docs.ts";

export const profileId = (groupId, botId) => `${groupId}::${botId}`;

export function createBotProfileStore(harness) {
  return {
    async get(groupId, botId, ctx) {
      const doc = await harness.snapshot(BotProfile, profileId(groupId, botId), ctx);
      if (!doc) return { instructions: "", model: "", updatedAt: 0 };
      return {
        instructions: doc.instructions ?? "",
        model: doc.model ?? "",
        updatedAt: Number(doc.updatedAt) || 0,
      };
    },

    async set(groupId, botId, input, ctx) {
      const value = {
        groupId,
        botId,
        instructions: String(input?.instructions ?? "").trim(),
        model: String(input?.model ?? "").trim(),
        updatedAt: Date.now(),
      };
      await harness.commit(async (tx) => {
        const doc = await tx.doc(BotProfile, profileId(groupId, botId), null);
        Object.assign(doc, value);
        return null;
      }, ctx);
      return { instructions: value.instructions, model: value.model, updatedAt: value.updatedAt };
    },
  };
}
