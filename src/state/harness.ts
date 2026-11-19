import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Harness, MemoryStorage, createRegistry, defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createGateway } from "../config/model.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openHarness(config, ctx) {
  const models = createModels();
  const isFaux = config.model.provider === "faux";

  if (isFaux) {
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 500 }, () => fauxAssistantMessage("delivered")));
  } else {
    // Real gateway: pi-ai resolves the key through the provider's own auth.
    const gateway = createGateway(config.gateway);
    models.setProvider(gateway.provider);
  }

  const registry = createRegistry();
  if (isFaux && (config.workDelayMs ?? 0) > 0) {
    // Simulated long-running work, offline only; a real model must not be padded.
    registry.install(
      defineExtension({
        name: "musebot-slow",
        hooks: [hook(GenerationTask, { beforeRequest: async () => { await sleep(config.workDelayMs); } })],
      }),
    );
  }

  let storage;
  if (config.storageFile === ":memory:") {
    storage = new MemoryStorage();
  } else {
    // SQLite needs the directory to exist; the default lives under bot/data/.
    await mkdir(path.dirname(path.resolve(config.storageFile)), { recursive: true });
    storage = await openNodeSqliteStorage(config.storageFile);
  }
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      ...(config.readOnly ? { readOnly: true } : {}),
      settings: {
        // A viewer must see other processes' commits, so never serve documents from cache.
        ...(config.readOnly ? { documentRetentionMs: 0 } : {}),
        // A stalled gateway must fail the attempt instead of parking a bot forever.
        stream: { timeoutMs: config.requestTimeoutMs ?? 120_000 },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1_000 },
        // Auto compaction off: its receipt lines leaked into replies and folding history
        // rewrote what bots see. `enabled` gates only the automatic pass; manual compact()
        // ignores it, so an explicit compact() stays available.
        compaction: { enabled: false },
      },
    },
    ctx,
  );
  if (!config.readOnly) harness.resume();
  return { harness, registry, models };
}
