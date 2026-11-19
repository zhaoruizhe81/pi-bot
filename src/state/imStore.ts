// Per-group IM bridge token. The token is a bearer secret in the URL path, so the settings
// page only ever shows it masked; rotating mints a new one and invalidates the old.
import { randomBytes } from "node:crypto";
import { ImBridge } from "./docs.ts";

const newToken = () => `imb_${randomBytes(18).toString("base64url")}`;

export const maskToken = (token) => {
  const value = String(token ?? "");
  if (!value) return "";
  return value.length <= 12 ? "••••" : `${value.slice(0, 8)}…${value.slice(-4)}`;
};

export function createImStore(harness) {
  return {
    async get(groupId, ctx) {
      const doc = await harness.snapshot(ImBridge, groupId, ctx);
      if (!doc || !doc.token) return { groupId, token: "", enabled: true, callbackUrl: "", updatedAt: 0 };
      return {
        groupId,
        token: doc.token,
        enabled: doc.enabled !== false,
        callbackUrl: doc.callbackUrl ?? "",
        updatedAt: Number(doc.updatedAt) || 0,
      };
    },

    async ensure(groupId, ctx) {
      const current = await this.get(groupId, ctx);
      if (current.token) return current;
      return this.set(groupId, { token: newToken() }, ctx);
    },

    async set(groupId, input, ctx) {
      const current = await this.get(groupId, ctx);
      const value = {
        groupId,
        token: String(input.token ?? current.token),
        enabled: input.enabled === undefined ? current.enabled : input.enabled !== false,
        callbackUrl: String(input.callbackUrl ?? current.callbackUrl),
        updatedAt: Date.now(),
      };
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ImBridge, groupId, null);
        Object.assign(doc, value);
        return null;
      }, ctx);
      return value;
    },

    async rotate(groupId, ctx) {
      return this.set(groupId, { token: newToken() }, ctx);
    },
  };
}
