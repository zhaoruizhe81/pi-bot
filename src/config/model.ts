// Real model wiring: one OpenAI-compatible gateway for every bot.
// The Jev classifier is deliberately NOT used yet (routing stays rule-based).
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";

export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" };

/** 默认网关;用 MUSEBOT_BASE_URL / MUSEBOT_API_KEY / MUSEBOT_MODEL 覆盖。 */
export const DEFAULT_BASE_URL = "http://127.0.0.1:3425/v1";
const DEFAULT_API_KEY = "";
export const DEFAULT_MODEL_ID = "workbuddy/deepseek-v4.1-flash";

/** Wire protocols the settings panel can pick from (each one is a real pi-ai api). */
export const API_KINDS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

const API_FACTORIES = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

export const isApiKind = (value) => Object.hasOwn(API_FACTORIES, String(value));

export function readModelConfig(env = process.env) {
  return {
    provider: "musebot",
    api: isApiKind(env.MUSEBOT_API) ? String(env.MUSEBOT_API) : "openai-completions",
    baseUrl: env.MUSEBOT_BASE_URL || DEFAULT_BASE_URL,
    apiKey: env.MUSEBOT_API_KEY || DEFAULT_API_KEY,
    modelId: env.MUSEBOT_MODEL || DEFAULT_MODEL_ID,
  };
}

/** Show a key without handing it to the page: `sk-mag…0b9b`. */
export function maskKey(key) {
  const value = String(key ?? "");
  if (!value) return "";
  if (value.length <= 10) return "••••";
  return value.slice(0, 5) + "…" + value.slice(-4);
}

/** Provider + the single model ref the bots use. */
export function createGateway({ baseUrl, apiKey, modelId, api = "openai-completions" }) {
  const kind = isApiKind(api) ? String(api) : "openai-completions";
  const model = {
    id: modelId,
    name: modelId,
    api: kind,
    provider: "musebot",
    baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  const provider = createProvider({
    id: "musebot",
    name: "Musebot Gateway",
    baseUrl,
    auth: {
      apiKey: {
        name: "Musebot API key",
        async resolve() {
          return apiKey ? { auth: { apiKey }, source: "MUSEBOT_API_KEY" } : undefined;
        },
      },
    },
    models: [model],
    api: API_FACTORIES[kind](),
  });
  return { provider, model, modelRef: { provider: "musebot", modelId } };
}
