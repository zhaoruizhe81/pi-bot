// The person using this client: one global profile shared by every group and device.
import { UserProfile } from "./docs.ts";

const DEFAULT_PROFILE = { name: "我", signature: "", avatar: "", updatedAt: 0 };

/** Validate a data-URL avatar: only real images, capped so the doc stays a small base. */
export function normalizeAvatar(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(text)) {
    throw new Error("avatar must be a base64 image data URL");
  }
  if (text.length > 240_000) throw new Error("avatar is too large (max 240 KB)");
  return text;
}

export function createProfileStore(harness) {
  return {
    /** The profile always exists logically; an untouched DB reports the defaults. */
    async get(ctx) {
      const doc = await harness.snapshot(UserProfile, ctx);
      if (!doc) return { ...DEFAULT_PROFILE };
      return {
        name: String(doc.name ?? "") || DEFAULT_PROFILE.name,
        signature: String(doc.signature ?? ""),
        avatar: String(doc.avatar ?? ""),
        updatedAt: Number(doc.updatedAt ?? 0),
      };
    },
    async set(input, ctx) {
      const name = String(input?.name ?? "").trim().slice(0, 24) || DEFAULT_PROFILE.name;
      const signature = String(input?.signature ?? "").trim().slice(0, 80);
      const avatar = normalizeAvatar(input?.avatar);
      const updatedAt = Date.now();
      await harness.commit(async (tx) => {
        const doc = await tx.doc(UserProfile, null);
        doc.name = name;
        doc.signature = signature;
        doc.avatar = avatar;
        doc.updatedAt = updatedAt;
        return null;
      }, ctx);
      return { name, signature, avatar, updatedAt };
    },
  };
}
