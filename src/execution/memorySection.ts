// Prompt section that injects one bot's long-term memory into its own conversation.
// Read-only: it never starts a run and never writes. Relevance is keyword overlap with
// the current request plus recency, so a fresh task sees the memories that matter most.
import { section } from "@earendil-works/pi-durable";

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_TOP_K = 6;

/** ASCII words plus CJK chars/bigrams; mirrors the store's cheap tokenizer. */
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

const overlap = (requestTokens, text) => {
  if (requestTokens.size === 0) return 0;
  let shared = 0;
  for (const token of tokens(text)) if (requestTokens.has(token)) shared += 1;
  return shared;
};

/** Score = keyword overlap (dominant) + recency (tie-breaker). */
const rank = (items, requestText, now) => {
  const requestTokens = tokens(requestText);
  const dayMs = 24 * 60 * 60 * 1000;
  return items
    .map((item) => {
      const ageDays = Math.max(0, now - (Number(item.at) || 0)) / dayMs;
      const recency = 1 / (1 + ageDays);
      const relevance = overlap(requestTokens, item.text) + recency * 0.5;
      return { item, relevance };
    })
    .sort((a, b) => b.relevance - a.relevance)
    .map((row) => row.item);
};

export function createMemorySection(deps) {
  return section("bot-memory", async (input, ctx) => {
    const ref = deps.botIdFor(input.conversationId);
    if (!ref) return undefined;
    const config = await deps.memory(ref.groupId, ref.botId, ctx);
    if (!config || config.enabled === false || (config.items ?? []).length === 0) return undefined;

    let requestText = "";
    if (deps.requestText) {
      try {
        requestText = await deps.requestText(input.conversationId, ctx);
      } catch {
        /* relevance falls back to recency when the request text is unavailable */
      }
    }

    const top = rank(config.items, requestText, Date.now()).slice(0, deps.topK ?? DEFAULT_TOP_K);
    if (top.length === 0) return undefined;
    const lines = top.map((item) => `- [${item.kind || "preference"}] ${String(item.text ?? "").trim()}`).filter((line) => line.length > 4);
    if (lines.length === 0) return undefined;
    const body = `你在这个群记住的长期偏好(遵守即可,不需要复述):\n${lines.join("\n")}`;
    return body.slice(0, deps.maxChars ?? DEFAULT_MAX_CHARS);
  });
}
