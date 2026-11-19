// Bot name/avatar is global: changing it changes every group and every avatar composite.
import { BotIdentityBook } from "./docs.ts";
import { normalizeAvatar } from "./profileStore.ts";

/** A bot avatar is either an image data URL or a short glyph (one emoji/character). */
export function normalizeBotAvatar(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^data:image\//i.test(text)) return normalizeAvatar(text);
  if (text.length > 8) throw new Error("bot avatar must be an image or at most 8 characters");
  return text;
}

export function createBotIdentityStore(harness) {
  return {
    async load(ctx) {
      return (await harness.snapshot(BotIdentityBook, ctx))?.bots ?? {};
    },
    async set(botId, patch, ctx) {
      const id = String(botId ?? "");
      if (!id) throw new Error("botId is required");
      const name = patch?.name === undefined ? undefined : String(patch.name ?? "").trim();
      if (name !== undefined && !name) throw new Error("bot name is required");
      if (name !== undefined && name.length > 24) throw new Error("bot name is too long (max 24)");
      const avatar = patch?.avatar === undefined ? undefined : normalizeBotAvatar(patch.avatar);
      const next = { name: name ?? "", avatar: avatar ?? "", updatedAt: Date.now() };
      await harness.commit(async (tx) => {
        const doc = await tx.doc(BotIdentityBook, null);
        const current = doc.bots[id] ?? { name: "", avatar: "", updatedAt: 0 };
        doc.bots[id] = {
          name: name === undefined ? current.name : next.name,
          avatar: avatar === undefined ? current.avatar : next.avatar,
          updatedAt: next.updatedAt,
        };
        return null;
      }, ctx);
      return (await harness.snapshot(BotIdentityBook, ctx))?.bots?.[id] ?? { name: "", avatar: "", updatedAt: 0 };
    },
  };
}
