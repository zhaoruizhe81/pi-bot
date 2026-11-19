// Long-term memory for one bot inside one group: a small durable list of short facts the
// bot should remember across tasks. Offline and dependency-free: extraction is thin and
// the store only needs the durable harness (no vector database).
import { Memory } from "./docs.ts";

export const memoryKey = (groupId, botId) => `${groupId}::${botId}`;

/** Hard cap per (group, bot); over it, the lowest-score/oldest item is evicted first. */
const MAX_ITEMS = 50;
const MAX_TEXT = 500;

const newMemoryId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Collapse a text to its comparable skeleton: lowercase, no whitespace, no punctuation. */
const normalize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：,.!?;:"'`~()（）\[\]{}<>《》「」【】…—\-_/\\]/g, "");

/**
 * Cheap token set: ASCII words plus CJK characters and bigrams. Good enough for the
 * "did the user already tell us this?" check without pulling in a tokenizer or model.
 */
const tokens = (text) => {
  const set = new Set();
  const value = String(text ?? "").toLowerCase();
  for (const word of value.match(/[a-z0-9]+/g) ?? []) set.add(word);
  for (const run of value.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length; i += 1) {
      set.add(run[i]);
      if (i + 1 < run.length) set.add(run.slice(i, i + 2));
    }
  }
  return set;
};

const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/** Two memories are the same when their normalized text matches or their tokens overlap heavily. */
const isDuplicate = (existingText, nextText) => {
  const left = normalize(existingText);
  const right = normalize(nextText);
  if (!left || !right) return false;
  if (left === right) return true;
  return jaccard(tokens(existingText), tokens(nextText)) >= 0.82;
};

const toView = (doc) => ({
  groupId: doc.groupId,
  botId: doc.botId,
  enabled: doc.enabled !== false,
  items: (doc.items ?? []).map((item) => ({
    id: item.id,
    text: item.text,
    kind: item.kind || "preference",
    source: item.source || "manual",
    at: Number(item.at) || 0,
    score: Number(item.score) || 1,
  })),
});

export function createMemoryStore(harness) {
  const empty = (groupId, botId) => ({ groupId, botId, enabled: true, items: [] });

  return {
    /** One bot's memory in one group; absent means "enabled, empty". Read-only. */
    async get(groupId, botId, ctx) {
      const doc = await harness.snapshot(Memory, memoryKey(groupId, botId), ctx);
      return doc ? toView(doc) : empty(groupId, botId);
    },

    /** Several bots' memory in one group (family docs cannot be enumerated, so ids are given). */
    async list(groupId, botIds, ctx) {
      return Promise.all(botIds.map((botId) => this.get(groupId, botId, ctx)));
    },

    /**
     * Add one memory. Duplicates (same normalized text or high token overlap) reinforce the
     * existing row instead of growing the list; over the cap the weakest row is evicted.
     */
    async add(groupId, botId, input, ctx) {
      const text = String(input?.text ?? "").trim();
      if (!text) throw new Error("memory text is required");
      if (text.length > MAX_TEXT) throw new Error(`memory text is too long (max ${MAX_TEXT})`);
      const kind = String(input?.kind ?? "preference").trim() || "preference";
      const source = String(input?.source ?? "manual").trim() || "manual";
      const now = Date.now();

      await harness.commit(async (tx) => {
        const doc = await tx.doc(Memory, memoryKey(groupId, botId), null);
        doc.groupId = groupId;
        doc.botId = botId;
        if (doc.enabled === undefined) doc.enabled = true;
        const existing = doc.items.find((item) => isDuplicate(item.text, text));
        if (existing) {
          existing.score = (Number(existing.score) || 1) + 1;
          existing.at = now;
          if (kind) existing.kind = kind;
          if (source) existing.source = source;
        } else {
          doc.items.push({ id: newMemoryId(), text, kind, source, at: now, score: 1 });
        }
        if (doc.items.length > MAX_ITEMS) {
          doc.items.sort((a, b) => (Number(a.score) || 1) - (Number(b.score) || 1) || (Number(a.at) || 0) - (Number(b.at) || 0));
          doc.items.splice(0, doc.items.length - MAX_ITEMS);
        }
        return null;
      }, ctx);
      return this.get(groupId, botId, ctx);
    },

    async remove(groupId, botId, memId, ctx) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Memory, memoryKey(groupId, botId), null);
        const at = doc.items.findIndex((item) => item.id === memId);
        if (at >= 0) doc.items.splice(at, 1);
        return null;
      }, ctx);
      return this.get(groupId, botId, ctx);
    },

    async clear(groupId, botId, ctx) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Memory, memoryKey(groupId, botId), null);
        doc.items.length = 0;
        return null;
      }, ctx);
      return this.get(groupId, botId, ctx);
    },

    async setEnabled(groupId, botId, enabled, ctx) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Memory, memoryKey(groupId, botId), null);
        doc.groupId = groupId;
        doc.botId = botId;
        doc.enabled = enabled !== false;
        return null;
      }, ctx);
      return this.get(groupId, botId, ctx);
    },
  };
}
