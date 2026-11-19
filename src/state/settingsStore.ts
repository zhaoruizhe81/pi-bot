// Process-wide settings that are worth keeping across restarts (today: the model endpoint).
// Everything else is either env-owned or per-group, so this stays a single small document.
import { Settings } from "./docs.ts";

export function createSettingsStore(harness, envConfig, envHost = "127.0.0.1") {
  /** env / defaults, used when the document has never been written. */
  const fallback = () => ({
    api: envConfig.api ?? "openai-completions",
    baseUrl: envConfig.baseUrl ?? "",
    modelId: envConfig.modelId ?? "",
    apiKey: envConfig.apiKey ?? "",
    host: envHost,
    updatedAt: 0,
  });

  return {
    fallback,

    async get(ctx) {
      const doc = await harness.snapshot(Settings, ctx);
      if (!doc || !doc.modelId) return { ...fallback(), source: "env" };
      return {
        api: doc.api || fallback().api,
        baseUrl: doc.baseUrl || fallback().baseUrl,
        modelId: doc.modelId,
        apiKey: doc.apiKey || fallback().apiKey,
        host: doc.host || fallback().host,
        updatedAt: Number(doc.updatedAt) || 0,
        source: "settings",
      };
    },

    /** Persist a full config; callers merge with `get` first so unset fields keep working. */
    async set(input, ctx) {
      const value = {
        api: String(input.api ?? ""),
        baseUrl: String(input.baseUrl ?? ""),
        modelId: String(input.modelId ?? ""),
        apiKey: String(input.apiKey ?? ""),
        host: String(input.host ?? ""),
        updatedAt: Date.now(),
      };
      await harness.commit(async (tx) => {
        const doc = await tx.doc(Settings);
        Object.assign(doc, value);
        return null;
      }, ctx);
      return { ...value, source: "settings" };
    },
  };
}
