// Turns one delivered task into 0-3 durable memories. Rules first (a user who says
// "记住/以后/偏好/口径/统一用…" is stating a preference; conclusion lines in a delivery
// are worth keeping), with an optional model hook that degrades to rules when offline.
// One-off task detail must NOT become a memory, so the body is only mined for explicit
// conclusion/"口径/约定/以后" lines, never for arbitrary sentences.

const TRIGGER = /(记住|请记住|记一下|别忘了|以后|今后|往后|下次|偏好|喜欢|不喜欢|习惯|倾向|口径|统一用|统一口径|统一格式|统一叫法|默认用|默认就是|约定|规范|叫法|一直|始终|永远|一律)/;
const CONCLUSION_START = /^(结论|口径|决定|建议|约定|注意|规范|以后|默认)/;
const CONCLUSION_HINT = /(统一口径|约定如下|以后都|默认用|规范是|原则是)/;
const MAX_TEXT = 200;

const splitSentences = (text) =>
  String(text ?? "")
    .split(/[。！？；\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const classify = (sentence) => {
  if (/(偏好|喜欢|不喜欢|习惯|倾向)/.test(sentence)) return "preference";
  if (/(口径|统一|默认|约定|规范|记住|以后|今后|一律|始终)/.test(sentence)) return "instruction";
  return "preference";
};

/** Rule-based candidates: preference-bearing requirement sentences, plus explicit conclusions. */
const extractCandidates = ({ requirement, subject, body }) => {
  const out = [];
  for (const sentence of splitSentences(requirement)) {
    if (!TRIGGER.test(sentence) || sentence.length > MAX_TEXT) continue;
    out.push({ text: sentence, kind: classify(sentence), source: "requirement" });
  }
  for (const sentence of splitSentences(`${subject ?? ""}\n${body ?? ""}`)) {
    if (sentence.length > MAX_TEXT) continue;
    if (!CONCLUSION_START.test(sentence) && !CONCLUSION_HINT.test(sentence)) continue;
    out.push({ text: sentence, kind: "conclusion", source: "delivery" });
  }
  return out;
};

export function createMemoryExtractor(deps = {}) {
  return {
    /**
     * Best-effort: never throws into the caller. `deps.model` is an optional async hook
     * `(delivery) => [{ text, kind }]`; without it (or when it fails) rules alone decide.
     */
    async afterDelivery(delivery, ctx) {
      const groupId = String(delivery?.groupId ?? "");
      const botId = String(delivery?.botId ?? "");
      if (!deps.store || !groupId || !botId) return [];

      let config;
      try {
        config = await deps.store.get(groupId, botId, ctx);
      } catch {
        return [];
      }
      if (config?.enabled === false) return [];

      const candidates = extractCandidates(delivery);
      if (deps.model) {
        try {
          const extra = await deps.model(delivery);
          if (Array.isArray(extra)) {
            for (const row of extra) if (row?.text) candidates.push({ text: String(row.text), kind: String(row.kind ?? "fact"), source: "model" });
          }
        } catch {
          /* offline or model failure: keep the rule-based candidates */
        }
      }

      const seen = new Set();
      const accepted = [];
      for (const candidate of candidates) {
        const text = String(candidate.text ?? "").trim();
        if (text.length < 4) continue;
        const norm = text.toLowerCase().replace(/\s+/g, "");
        if (seen.has(norm)) continue;
        seen.add(norm);
        accepted.push({ text: text.slice(0, MAX_TEXT), kind: candidate.kind || "preference", source: candidate.source || "requirement" });
        if (accepted.length >= 3) break;
      }

      const saved = [];
      for (const item of accepted) {
        try {
          saved.push(await deps.store.add(groupId, botId, item, ctx));
        } catch {
          /* one bad item never blocks the others */
        }
      }
      return saved;
    },
  };
}
