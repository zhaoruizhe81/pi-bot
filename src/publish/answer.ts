/**
 * The group only ever sees the bot's answer text, never its transcript.
 * Reads the newest `pi.assistant` entry of the bot's private conversation.
 */
const MAX_BODY = 12_000;

// Compaction receipt lines the harness writes into the transcript; a whole line
// that starts with one of them is never content, so it is stripped on the way out.
const ACP_PREFIXES = ["📦 [ACP]", "[Compressed", "[Decompressed"];
const FOLDED_FALLBACK = "(已折叠历史上下文)";

const isAcpLine = (line) => {
  const trimmed = line.trim();
  return ACP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
};

export function stripAcpLines(text) {
  const source = String(text ?? "");
  const kept = source.split("\n").filter((line) => !isAcpLine(line));
  const visible = kept.join("\n").trim();
  // An answer made only of receipt lines folds to one notice; a blank input stays blank,
  // so the caller's own empty-answer fallback keeps working.
  if (!visible && source.trim()) return FOLDED_FALLBACK;
  return visible;
}

const textOf = (message) => {
  if (!message || message.role !== "assistant") return "";
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
};

export async function readAnswer(conv, ctx) {
  const page = await conv.entries({}, 40, undefined, ctx);
  for (const entry of page.items) {
    if (entry.kind !== "pi.assistant") continue;
    const messages = Array.isArray(entry.model) ? entry.model : [];
    const text = messages.map(textOf).filter(Boolean).join("\n").trim();
    if (text) {
      const visible = stripAcpLines(text);
      return visible.length > MAX_BODY ? `${visible.slice(0, MAX_BODY)}\n\n…(已截断)` : visible;
    }
  }
  return "";
}
