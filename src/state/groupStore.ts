// Group registry + shared group context (announcement, pins), both durable (M2).
import { Directory, Group, Pin } from "./docs.ts";

const newGroupId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const newPinId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * Session-scoped groups. The durable truth is `musebot.directory` + one `musebot.group`
 * per id; the maps here are only a read-through cache for the conversation -> group lookup
 * that prompt sections need synchronously.
 */
export function createGroupStore(harness) {
  const docs = new Map();
  const byConv = new Map();
  /** bot conversation id -> { groupId, botId }; prompt sections run synchronously, so keep it indexed. */
  const botConv = new Map();
  const inflight = new Map();
  let loaded = false;

  const index = (doc) => {
    docs.set(doc.id, doc);
    if (doc.groupConversationId) byConv.set(doc.groupConversationId, doc.id);
    if (doc.orchConversationId) byConv.set(doc.orchConversationId, doc.id);
    for (const [botId, conversationId] of Object.entries(doc.botConversations ?? {})) {
      byConv.set(conversationId, doc.id);
      botConv.set(String(conversationId), { groupId: doc.id, botId });
    }
  };

  async function load(ctx) {
    if (loaded) return;
    const dir = await harness.snapshot(Directory, ctx);
    for (const id of dir?.ids ?? []) {
      const doc = await harness.snapshot(Group, id, ctx);
      if (doc) index(doc);
    }
    loaded = true;
  }

  /** Re-read every group from storage; a viewer process needs this to see another writer. */
  async function refreshAll(ctx) {
    const dir = await harness.snapshot(Directory, ctx);
    const next = new Map();
    for (const id of dir?.ids ?? []) {
      const doc = await harness.snapshot(Group, id, ctx);
      if (doc) next.set(id, doc);
    }
    docs.clear();
    byConv.clear();
    botConv.clear();
    for (const doc of next.values()) index(doc);
    loaded = true;
  }

  async function refresh(id, ctx) {
    const doc = await harness.snapshot(Group, id, ctx);
    if (doc) index(doc);
    return doc;
  }

  return {
    load,
    refreshAll,
    async list(ctx) {
      await load(ctx);
      return [...docs.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    async get(id, ctx) {
      await load(ctx);
      return docs.get(id) ?? (await refresh(id, ctx));
    },
    /**
     * Create a group with all of its conversations in one commit, so a group is never
     * half-wired after a crash. An existing id is returned unchanged.
     */
    async ensure(spec, ctx) {
      await load(ctx);
      const id = spec.id ?? newGroupId();
      const pending = inflight.get(id);
      if (pending) await pending;
      const known = docs.get(id);
      if (known) return { doc: known, created: false };

      const run = (async () => {
        const createdAt = Date.now();
        const roster = [...(spec.roster ?? [])];
        await harness.commit(async (tx) => {
          const group = await tx.doc(Group, id, {
            id,
            name: spec.name ?? id,
            roster,
            rules: spec.rules ?? "",
            topic: spec.topic ?? "",
            createdAt,
          });
          // Optional kind marker ("dm"); a normal group leaves the field absent.
          if (spec.type) group.type = spec.type;
          group.groupConversationId = String((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
          group.orchConversationId = String((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
          for (const botId of roster) {
            group.botConversations[botId] = String((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
          }
          const dir = await tx.doc(Directory);
          if (!dir.ids.includes(id)) dir.ids.push(id);
          return null;
        }, ctx);
        const doc = await refresh(id, ctx);
        if (!doc) throw new Error(`group ${id} vanished right after creation`);
        return doc;
      })();

      inflight.set(id, run);
      try {
        const doc = await run;
        return { doc, created: true };
      } finally {
        inflight.delete(id);
      }
    },
    /** Add a bot to the roster, minting its conversation on first join (kept if it leaves). */
    async addMember(id, botId, ctx) {
      const current = await this.get(id, ctx);
      if (!current) throw new Error(`unknown group: ${id}`);
      const conversationId = await harness.commit(async (tx) => {
        const group = await tx.doc(Group, id, {
          id: current.id,
          name: current.name,
          roster: [...current.roster],
          rules: current.rules,
          topic: current.topic,
          createdAt: current.createdAt,
        });
        if (!group.roster.includes(botId)) group.roster.push(botId);
        let existing = group.botConversations[botId];
        if (!existing) {
          existing = String((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
          group.botConversations[botId] = existing;
        }
        return existing;
      }, ctx);
      await refresh(id, ctx);
      return { conversationId: Number(conversationId) };
    },

    async removeMember(id, botId, ctx) {
      const current = await this.get(id, ctx);
      if (!current) throw new Error(`unknown group: ${id}`);
      await harness.commit(async (tx) => {
        const group = await tx.doc(Group, id, {
          id: current.id,
          name: current.name,
          roster: [...current.roster],
          rules: current.rules,
          topic: current.topic,
          createdAt: current.createdAt,
        });
        const at = group.roster.indexOf(botId);
        if (at >= 0) group.roster.splice(at, 1);
        return null;
      }, ctx);
      await refresh(id, ctx);
    },

    groupIdForConversation(conversationId) {
      return byConv.get(String(conversationId));
    },

    /** Reverse lookup for prompt sections: which (group, bot) owns this conversation. */
    botIdForConversation(conversationId) {
      return botConv.get(String(conversationId));
    },

    /** Rename a group. Ids, conversations and history are untouched. */
    async setName(id, name, ctx) {
      const current = await this.get(id, ctx);
      if (!current) throw new Error(`unknown group: ${id}`);
      await harness.commit(async (tx) => {
        const group = await tx.doc(Group, id, {
          id: current.id,
          name: current.name,
          roster: [...current.roster],
          rules: current.rules,
          topic: current.topic,
          createdAt: current.createdAt,
        });
        group.name = String(name ?? "").trim() || current.name;
        return null;
      }, ctx);
      await refresh(id, ctx);
    },

    async pin(id, ctx) {
      return (await harness.snapshot(Pin, id, ctx)) ?? { announcement: "", pins: [] };
    },
    async setAnnouncement(id, announcement, ctx) {
      await harness.commit(async (tx) => {
        (await tx.doc(Pin, id, null)).announcement = String(announcement ?? "");
        return null;
      }, ctx);
    },
    async addPin(id, input, ctx) {
      const item = { id: newPinId(), text: String(input.text ?? ""), by: String(input.by ?? ""), at: Date.now() };
      await harness.commit(async (tx) => {
        (await tx.doc(Pin, id, null)).pins.push(item);
        return null;
      }, ctx);
      return item;
    },
    async removePin(id, pinId, ctx) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Pin, id, null);
        const at = doc.pins.findIndex((p) => p.id === pinId);
        if (at >= 0) doc.pins.splice(at, 1);
        return null;
      }, ctx);
    },
  };
}
