// Composition root: harness + durable group registry + one runtime per group.
import { defineExtension, section } from "@earendil-works/pi-durable";
import { BOTS } from "./config/bots.ts";
import { API_KINDS, FAUX_MODEL, createGateway, maskKey, readModelConfig } from "./config/model.ts";
import { openHarness } from "./state/harness.ts";
import { createBotRegistry } from "./state/botRegistry.ts";
import { createGroupStore } from "./state/groupStore.ts";
import { createSettingsStore } from "./state/settingsStore.ts";
import { createBotProfileStore } from "./state/botProfileStore.ts";
import { createUploadStore } from "./state/uploads.ts";
import { createImStore, maskToken } from "./state/imStore.ts";
import { createProfileStore } from "./state/profileStore.ts";
import { BOT_CAPABILITIES, createCustomBotStore } from "./state/customBotStore.ts";
import { createBotIdentityStore } from "./state/botIdentityStore.ts";
import { createSkillStore } from "./state/skillStore.ts";
import {
  HOST_CHOICES,
  disableServe,
  enableServe,
  isHostChoice,
  lanAddresses,
  serveStatus,
  tailscaleStatus,
} from "./state/network.ts";
import { createWorkGraph } from "./state/workGraph.ts";
import { createArtifactStore } from "./publish/artifacts.ts";
import { createMemoryStore } from "./state/memoryStore.ts";
import { createWorkItemTask } from "./execution/workItemTask.ts";
import { readAnswer } from "./publish/answer.ts";
import { createGroupPinSection } from "./execution/groupContext.ts";
import { createMemorySection } from "./execution/memorySection.ts";
import { createSkillsSection } from "./execution/skillsSection.ts";
import { createMemoryExtractor } from "./execution/memoryExtractor.ts";
import { openGroupRuntime } from "./execution/groupRuntime.ts";
import { createPlanner } from "./orchestration/planner.ts";
import { createRouter } from "./orchestration/router.ts";
import { createWorkspace } from "./execution/workspace.ts";
import { createWriteFileTool } from "./execution/fileTool.ts";
import { createBashTool, createReadTool } from "./execution/tools.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function createMusebot(opts, ctx) {
  /** Default is the offline faux model; `main.ts` passes the real gateway model. */
  const model = opts.model ?? FAUX_MODEL;
  const { harness, registry, models } = await openHarness(
    {
      storageFile: opts.storageFile ?? ":memory:",
      model,
      gateway: opts.gateway,
      readOnly: opts.readOnly === true,
      workDelayMs: opts.workDelayMs ?? 2000,
    },
    ctx,
  );

  const startedAt = Date.now();
  const envModel = opts.gateway ?? readModelConfig();
  // Built-in bots are code; user-created bots are durable rows merged into the same roster.
  const customBots = createCustomBotStore(harness);
  await customBots.load(ctx);
  const bots = [...(opts.bots ?? BOTS), ...customBots.list()].map((bot) => ({
    ...bot,
    agent: { ...bot.agent, model },
  }));
  // Name/avatar overrides are global and applied before the registry is built, so every
  // planner prompt, message author and avatar composite sees the same identity.
  const botIdentities = createBotIdentityStore(harness);
  const identityBook = await botIdentities.load(ctx);
  const botDefaults = new Map(bots.map((bot) => [bot.id, { name: bot.name, avatar: bot.avatar ?? "" }]));
  for (const bot of bots) {
    const identity = identityBook[bot.id];
    if (!identity) continue;
    if (identity.name) bot.name = identity.name;
    if (identity.avatar) bot.avatar = identity.avatar;
  }
  const botRegistry = createBotRegistry(bots);
  const profileStore = createProfileStore(harness);
  const groupStore = createGroupStore(harness);
  const settingsStore = createSettingsStore(harness, envModel, process.env.MUSEBOT_HOST ?? "127.0.0.1");
  const profiles = createBotProfileStore(harness);
  const graph = createWorkGraph(harness);
  const artifacts = createArtifactStore(harness);
  const workspaceRoot = opts.workspaceRoot ?? path.join(process.cwd(), "data", "workspace");
  const workspace = createWorkspace(workspaceRoot, opts.archiveRoot);
  const uploads = createUploadStore(opts.uploadRoot ?? path.join(workspaceRoot, "..", "uploads"));
  const imStore = createImStore(harness);
  const memoryStore = createMemoryStore(harness);
  const memoryExtractor = createMemoryExtractor({ store: memoryStore });
  // Installed pi skills: the bot dir owns the project-level copy; `main.ts` may override.
  const skillStore = createSkillStore({
    harness,
    botDir: opts.botDir ?? path.resolve(fileURLToPath(new URL("../", import.meta.url))),
  });

  /** Latest user text of a conversation, so memory retrieval can rank by relevance. */
  const latestUserText = async (conversationId, context) => {
    const conv = await harness.conversation(Number(conversationId), context);
    if (!conv) return "";
    const page = await conv.entries({}, 20, undefined, context);
    for (const entry of page.items) {
      if (entry.kind !== "pi.user") continue;
      const text = (entry.model ?? [])
        .map((message) => {
          if (message?.role !== "user") return "";
          const parts = Array.isArray(message.content) ? message.content : [];
          return parts
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join(" ");
        })
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return "";
  };

  /** groupId -> runtime; rebuilt from documents, never persisted itself. */
  const runtimes = new Map();
  const groupListeners = new Set();
  /** groupId -> watcher callbacks that want the detail (announcement / pins / roster). */
  const groupNotifiers = new Map();

  const workItemTask = createWorkItemTask({
    harness,
    retryMs: opts.retryMs ?? 500,
    resolveGroup: (groupId) => {
      const runtime = runtimes.get(groupId);
      if (!runtime) throw new Error(`unknown group: ${groupId}`);
      return runtime;
    },
    // After a delivery succeeds, mine the requirement + answer for durable memories.
    onDelivered: async (delivery) => {
      try {
        await memoryExtractor.afterDelivery(delivery, ctx);
      } catch {
        /* memory is best-effort; a failed extraction never affects delivery */
      }
    },
  });

  registry.install(defineExtension({ name: "musebot-core", tasks: [workItemTask] }));
  // Tools resolve through the registry, so a locally defined tool must be installed here;
  // `configure({tools})` only narrows what the registry already offers.
  registry.install(defineExtension({ name: "musebot-write-file", tools: [createWriteFileTool(workspace)] }));
  registry.install(defineExtension({ name: "musebot-tools", tools: [createReadTool(workspace), createBashTool(workspace)] }));
  registry.install(
    defineExtension({
      name: "musebot-group-context",
      sections: [
        section(
          "deliverable-files",
          (input) => {
            // A DM chat answers in conversation; its files land in the workspace and cannot
            // be downloaded from the private chat yet. Normal groups keep the deliverable flow.
            const groupId = groupStore.groupIdForConversation(input.conversationId);
            if (groupId && runtimes.get(groupId)?.doc.type === "dm") {
              return (
                "这是和用户的私聊:以直接回答用户的问题为主,像对话一样交流。" +
                "确需产出文件时,可以调用 write_file 写入工作区,并用一句话说明文件保存在了工作区(私聊里暂时不能下载文件)。"
              );
            }
            return (
              "需要产出文件(报告/表格/代码/diff)时,调用 write_file 写相对路径(如 q3-report.md)," +
              "写完后用一两句话说明交付了什么;不要只把长文贴在聊天里。"
            );
          },
        ),
        createGroupPinSection({
          groupIdFor: (conversationId) => groupStore.groupIdForConversation(conversationId),
          pin: (groupId, context) => groupStore.pin(groupId, context),
        }),
        createMemorySection({
          botIdFor: (conversationId) => groupStore.botIdForConversation(conversationId),
          memory: (groupId, botId, context) => memoryStore.get(groupId, botId, context),
          requestText: (conversationId, context) => latestUserText(conversationId, context),
        }),
        createSkillsSection({
          botIdFor: (conversationId) => groupStore.botIdForConversation(conversationId),
          enabledSkills: (botId, context) => skillStore.enabledFor(botId, context),
        }),
      ],
    }),
  );

  /** Last entry of a group, for the list preview; undefined when the group is empty. */
  const lastPreview = async (groupId) => {
    const runtime = runtimes.get(groupId);
    if (!runtime) return undefined;
    const conv = await harness.conversation(runtime.groupConversationId, ctx);
    if (!conv) return undefined;
    const page = await conv.entries({}, 1, undefined, ctx);
    const entry = page.items[0];
    if (!entry) return undefined;
    const data = entry.data ?? {};
    return {
      id: String(entry.id),
      kind: entry.kind,
      ev: typeof data.ev === "string" ? data.ev : undefined,
      text: typeof data.text === "string" ? data.text : undefined,
      // Work cards carry the task title; the list preview wants it too.
      subject: typeof data.subject === "string" ? data.subject : undefined,
      name: typeof data.file?.name === "string" ? data.file.name : undefined,
      mime: typeof data.file?.mime === "string" ? data.file.mime : undefined,
      error: typeof data.error === "string" ? data.error : typeof data.reason === "string" ? data.reason : undefined,
      at: typeof data.at === "number" ? data.at : undefined,
    };
  };

  const listGroups = async () => {
    const docs = await groupStore.list(ctx);
    return Promise.all(
      docs.map(async (doc) => ({
        id: doc.id,
        name: doc.name,
        type: doc.type,
        roster: [...doc.roster],
        createdAt: doc.createdAt,
        last: await lastPreview(doc.id),
      })),
    );
  };

  const emitGroups = () => {
    void listGroups().then((groups) => {
      for (const send of groupListeners) send({ type: "groups", groups });
    }).catch(() => undefined);
  };

  const openRuntime = async (doc) => {
    const cached = runtimes.get(doc.id);
    if (cached) return cached;
    const runtime = await openGroupRuntime({
      doc,
      harness,
      botRegistry,
      graph,
      artifacts,
      workItemTask,
      workspace,
      profiles,
      configureBots: opts.readOnly !== true,
      ctx,
    });
    runtimes.set(doc.id, runtime);
    return runtime;
  };

  /** Idempotent: an existing group id returns its runtime without touching its history. */
  const ensureGroup = async (spec) => {
    const { doc, created } = await groupStore.ensure(
      {
        id: spec.id,
        name: spec.name,
        roster: spec.roster ?? bots.map((bot) => bot.id),
        rules: spec.rules,
        topic: spec.topic,
      },
      ctx,
    );
    const runtime = await openRuntime(doc);
    if (created) emitGroups();
    return runtime;
  };

  await groupStore.load(ctx);
  const existing = await groupStore.list(ctx);
  if (existing.length === 0 && opts.readOnly !== true) {
    await ensureGroup({ id: opts.groupId ?? "g1", name: opts.groupName ?? "产品研发群" });
  } else {
    for (const doc of existing) await openRuntime(doc);
  }

  // Same-process changes fan out immediately; another process' commits are only visible
  // by polling, which a viewer (read-only) deployment turns on.
  let lastGroupsJson = JSON.stringify(await listGroups());
  const pollMs = opts.groupPollMs ?? 0;
  if (pollMs > 0) {
    setInterval(() => {
      void groupStore
        .refreshAll(ctx)
        .then(() => listGroups())
        .then((groups) => {
          const json = JSON.stringify(groups);
          if (json === lastGroupsJson) return;
          lastGroupsJson = json;
          for (const send of groupListeners) send({ type: "groups", groups });
        })
        .catch(() => undefined);
    }, pollMs).unref?.();
  }

  const toItem = (entry) => ({ id: String(entry.id), kind: entry.kind, data: entry.data });

  /** One page of the group's history, newest page first, displayed oldest-first. */
  const items = async (groupId, options = {}) => {
    const runtime = runtimes.get(groupId);
    if (!runtime) return undefined;
    const conv = await harness.conversation(runtime.groupConversationId, ctx);
    if (!conv) return { items: [], next: undefined };
    const limit = Math.min(Math.max(Number(options.limit ?? 100), 1), 500);
    const page = await conv.entries({}, limit, options.before, ctx);
    return {
      items: page.items.slice().sort((a, b) => Number(a.id) - Number(b.id)).map(toItem),
      next: page.next,
    };
  };

  const readItems = async (groupId) => (await items(groupId, { limit: 500 }))?.items;

  const watchGroup = async (groupId, send) => {
    const runtime = runtimes.get(groupId);
    if (!runtime) throw new Error(`unknown group: ${groupId}`);
    const conv = await harness.conversation(runtime.groupConversationId, ctx);
    if (!conv) throw new Error(`group ${groupId}: conversation missing`);
    const watch = await conv.watch(ctx);
    const push = async () => {
      const page = await items(groupId, { limit: 100 });
      send({ type: "state", groupId, items: page.items, next: page.next });
    };
    await push();
    // Announcement / pin edits are not conversation entries, so the writer nudges its own
    // watchers: an open sheet updates without a reload.
    const pushDetail = async () => {
      const detail = await api.groupDetail(groupId).catch(() => undefined);
      if (detail) send({ type: "detail", groupId, detail });
    };
    const bucket = groupNotifiers.get(groupId) ?? new Set();
    bucket.add(pushDetail);
    groupNotifiers.set(groupId, bucket);
    watch.start(async (call) => {
      if (call.kind === "value") await push();
    });
    return async () => {
      bucket.delete(pushDetail);
      if (bucket.size === 0) groupNotifiers.delete(groupId);
      await watch.stop();
    };
  };

  /** Fan a group-detail change out to this group's watchers (same process only). */
  const notifyGroup = (groupId) => {
    for (const fn of [...(groupNotifiers.get(groupId) ?? [])]) void fn();
  };

  const watchGroups = async (send) => {
    groupListeners.add(send);
    send({ type: "groups", groups: await listGroups() });
    return () => {
      groupListeners.delete(send);
    };
  };

  /** `@领导` / `@财务bot` -> bot ids, so a chat line can address someone. */
  const mentionsIn = (text) => {
    const found = [];
    for (const match of String(text).matchAll(/@([^\s@,，。:：;；]+)/g)) {
      const name = match[1].trim();
      const bot = bots.find((candidate) => candidate.name === name || candidate.id === name);
      if (bot) found.push(bot.id);
    }
    return found;
  };

  const planner = createPlanner({
    leaderId: botRegistry.leader()?.id,
    conversationFor: (groupId, context) => runtimeFor(groupId).conversationFor(botRegistry.leader()?.id ?? "leader", context),
  });
  const router = createRouter();

  const runtimeFor = (groupId) => {
    const runtime = runtimes.get(groupId);
    if (!runtime) throw new Error(`unknown group: ${groupId}`);
    return runtime;
  };

  /**
   * A DM group has one bot: every human line is addressed to it. The line is posted to the
   * group, then drives one direct generation round on that bot's own conversation — the same
   * `conv.submit` a work item uses, but with no plan, no work items and no cards. The round's
   * answer is appended as a plain chat.message from the bot, bubble for bubble. A busy
   * conversation queues the line and answers it at the next boundary, so rapid sends keep order.
   */
  const dmDeliver = async (groupId, text, author, at) => {
    const runtime = runtimeFor(groupId);
    const requirement = String(text ?? "").trim();
    if (!requirement) return undefined;
    const botId = runtime.doc.roster[0];
    const botAuthor = { type: "bot", id: botId, name: botRegistry.get(botId)?.name ?? String(botId) };
    await runtime.channel.speak(
      requirement,
      author ?? { type: "human", id: "u1", name: "我" },
      ctx,
      typeof at === "number" ? at : undefined,
    );
    void (async () => {
      try {
        const conv = await runtime.conversationFor(botId, ctx);
        if (!conv) throw new Error(`bot conversation missing: ${botId}`);
        // The only work.event a DM ever shows: a gray "working" row while the reply generates.
        await runtime.channel.append({ kind: "work.event", data: { ev: "正在处理…", by: botId } }, ctx);
        const submission = await conv.submit({ type: "input", content: requirement }, ctx);
        const settled = await submission.wait(ctx);
        const answer = settled.status === "done" ? await readAnswer(conv, ctx) : "";
        // `detail` is the error text durable stores for a failed run (e.g. a 413 body);
        // surfacing its head keeps the cause from being swallowed by a bare "model_error".
        const cause =
          settled.status === "unanswered" && settled.detail !== undefined && settled.detail !== null
            ? (typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)).slice(0, 120)
            : "";
        const reason = cause
          ? `${String(settled.reason ?? "未知原因")}: ${cause}`
          : String(settled.reason ?? "未知原因");
        const fallback =
          settled.status === "done"
            ? "这轮我没有得出回答,换个说法再试试?"
            : `这轮没有完成(${reason}),再试一次?`;
        await runtime.channel.speak(answer || fallback, botAuthor, ctx);
      } catch (error) {
        await runtime.channel
          .speak(`处理时出了问题:${String(error?.message ?? error)}`, botAuthor, ctx)
          .catch(() => undefined);
      }
    })();
    return undefined;
  };

  /**
   * Point every conversation at `config` and swap the provider in the models registry.
   * Runs already in flight keep their model; the next submission picks this one up.
   */
  const applyModel = async (config) => {
    if (opts.model?.provider === "faux") return; // offline tests keep the faux provider
    const gateway = createGateway(config);
    models.setProvider(gateway.provider);
    for (const bot of bots) bot.agent.model = { provider: "musebot", modelId: config.modelId };
    for (const runtime of runtimes.values()) {
      for (const botId of runtime.members()) {
        const conv = await runtime.conversationFor(botId, ctx);
        await conv?.configure({ model: { provider: "musebot", modelId: config.modelId } }, ctx).catch(() => undefined);
      }
    }
    return gateway;
  };

  const settingsView = async () => {
    const current = await settingsStore.get(ctx);
    return {
      api: current.api,
      baseUrl: current.baseUrl,
      modelId: current.modelId,
      apiKeyMask: maskKey(current.apiKey),
      apiKeySet: Boolean(current.apiKey),
      source: current.source,
      host: current.host,
      hosts: HOST_CHOICES,
      updatedAt: current.updatedAt,
      apis: API_KINDS,
      provider: "musebot",
      providerName: "Musebot Gateway",
      env: {
        api: envModel.api ?? "openai-completions",
        baseUrl: envModel.baseUrl,
        modelId: envModel.modelId,
      },
    };
  };

  /** Recent bridge traffic, kept in memory only: it is diagnostics, not group history. */
  const imTraffic = new Map();
  const imLog = (groupId, entry) => {
    const list = imTraffic.get(groupId) ?? [];
    list.push(entry);
    if (list.length > 40) list.splice(0, list.length - 40);
    imTraffic.set(groupId, list);
  };
  const imRecent = async (groupId) => imTraffic.get(groupId) ?? [];
  const nameOfBot = (botId) => botRegistry.get(botId)?.name ?? String(botId ?? "");

  const api = {
    harness,
    registry,
    // The models registry, for hosts (and offline smokes) that script or swap providers.
    models,
    bots,
    botRegistry,
    groupStore,
    graph,
    artifacts,
    planner,
    router,
    listGroups,
    ensureGroup,
    /**
     * Find-or-create the 1:1 DM group with one bot (`dm-<botId>`, `type: "dm"`).
     * Idempotent; an unknown botId throws so the route can answer 404.
     */
    openDm: async (botId) => {
      const bot = botRegistry.get(String(botId ?? "").trim());
      if (!bot) throw new Error(`unknown bot: ${botId}`);
      const { doc, created } = await groupStore.ensure({ id: `dm-${bot.id}`, name: bot.name, roster: [bot.id], type: "dm" }, ctx);
      await openRuntime(doc);
      if (created) emitGroups();
      // The full group document, plain-object copied so callers cannot hold draft references.
      return {
        id: doc.id,
        name: doc.name,
        type: doc.type,
        roster: [...doc.roster],
        rules: doc.rules,
        topic: doc.topic,
        createdAt: doc.createdAt,
        groupConversationId: doc.groupConversationId,
        orchConversationId: doc.orchConversationId,
        botConversations: { ...doc.botConversations },
      };
    },
    group: (groupId) => runtimes.get(groupId),
    readItems,
    items,
    /** Group detail for the UI: announcement/pins plus member metadata and busy state. */
    groupDetail: async (groupId) => {
      const runtime = runtimes.get(groupId);
      if (!runtime) return undefined;
      const doc = await groupStore.get(groupId, ctx);
      const pin = await groupStore.pin(groupId, ctx);
      const members = await Promise.all(
        runtime.members().map(async (botId) => {
          const bot = botRegistry.get(botId);
          return {
            id: botId,
            name: bot?.name ?? botId,
            role: bot?.role ?? "worker",
            capabilities: bot?.capabilities ?? [],
            avatar: bot?.avatar ?? "",
            custom: bot?.custom === true,
            busy: await runtime.activity.isBusy(botId, ctx),
          };
        }),
      );
      return {
        group: doc ? { id: doc.id, name: doc.name, type: doc.type, roster: [...doc.roster], createdAt: doc.createdAt, rules: doc.rules, topic: doc.topic } : undefined,
        members,
        announcement: pin.announcement ?? "",
        pins: pin.pins ?? [],
      };
    },
    watchGroup,
    watchGroups,
    /** IM bridge config for one group; the token is masked for the page. */
    imConfig: async (groupId) => {
      runtimeFor(groupId);
      const config = await imStore.ensure(groupId, ctx);
      return {
        groupId,
        enabled: config.enabled,
        callbackUrl: config.callbackUrl,
        tokenMask: maskToken(config.token),
        tokenSet: Boolean(config.token),
        // The full URL is only shown once, right after generating — this flag lets the UI say so.
        inboundPath: `/api/im/${encodeURIComponent(groupId)}`,
        updatedAt: config.updatedAt,
        recent: (await imRecent(groupId)).slice(-6).reverse(),
      };
    },
    imRotate: async (groupId) => {
      runtimeFor(groupId);
      const config = await imStore.rotate(groupId, ctx);
      return { ...(await api.imConfig(groupId)), token: config.token, tokenMask: maskToken(config.token) };
    },
    imUpdate: async (groupId, input) => {
      runtimeFor(groupId);
      await imStore.set(groupId, input, ctx);
      return api.imConfig(groupId);
    },
    /**
     * Inbound from an IM relay: token in the path, text in the body. It goes through the same
     * `chat()` router a person uses, so "帮我整理周报" becomes work and "收到" stays chat.
     */
    imInbound: async (groupId, token, payload) => {
      runtimeFor(groupId);
      const config = await imStore.get(groupId, ctx);
      if (!config.token || token !== config.token) throw new Error("invalid bridge token");
      if (!config.enabled) throw new Error("bridge is disabled");
      const text = String(payload?.text ?? "").trim();
      if (!text) throw new Error("text is required");
      const sender = String(payload?.sender ?? payload?.from ?? "IM 用户").slice(0, 40);
      const author = { type: "human", id: `im:${String(payload?.senderId ?? sender).slice(0, 40)}`, name: sender };
      const decision = await router.route({ text, mentions: mentionsIn(text) }, ctx);
      const isRequirement = decision.respond && decision.speaker.kind === "leader";
      if (isRequirement) await api.requirement(groupId, text, author);
      else await api.send(groupId, { text, author, at: payload?.at });
      imLog(groupId, { direction: "in", text, sender, routed: isRequirement ? "requirement" : "chat", at: Date.now() });
      return { ok: true, routed: isRequirement ? "requirement" : "chat" };
    },
    /** Pull endpoint for a relay: entries newer than `since`, oldest first. */
    imOutbox: async (groupId, token, since = 0) => {
      runtimeFor(groupId);
      const config = await imStore.get(groupId, ctx);
      if (!config.token || token !== config.token) throw new Error("invalid bridge token");
      const all = (await readItems(groupId)) ?? [];
      const cursor = Number(since) || 0;
      const rows = all
        .filter((entry) => Number(entry.id) > cursor)
        .slice(0, 200)
        .map((entry) => {
          const data = entry.data ?? {};
          const base = { id: Number(entry.id), kind: entry.kind, at: data.at ?? null };
          if (entry.kind === "chat.message") {
            return { ...base, author: data.author?.name ?? "", text: data.text ?? "" };
          }
          if (entry.kind === "chat.file") {
            return { ...base, author: data.author?.name ?? "", file: data.file ?? null };
          }
          if (entry.kind === "work.event" && data.ev === "delivered") {
            return { ...base, author: nameOfBot(data.botId), text: data.artifact?.body ?? "", subject: data.subject ?? "" };
          }
          return base;
        });
      return { items: rows, next: rows.length ? rows[rows.length - 1].id : cursor };
    },
    /** A file the user picked in the composer; stored on disk and posted as a chat.file entry. */
    sendFile: async (groupId, input) => {
      const runtime = runtimeFor(groupId);
      const stored = await uploads.put(groupId, input);
      await runtime.channel.attach(
        stored,
        input.author ?? { type: "human", id: "u1", name: "我" },
        ctx,
        typeof input.at === "number" ? input.at : undefined,
      );
      return stored;
    },
    /** Read one uploaded file back for download/playback. */
    uploadFile: (groupId, id) => {
      runtimeFor(groupId);
      return uploads.get(groupId, id);
    },
    send: async (groupId, input) => {
      const runtime = runtimeFor(groupId);
      // In a DM the single bot is always the addressee, so a plain chat line doubles as its task input.
      if (runtime.doc.type === "dm") return dmDeliver(groupId, input.text, input.author, input.at);
      return runtime.channel.speak(
        String(input.text ?? ""),
        input.author ?? { type: "human", id: "u1", name: "我" },
        ctx,
        typeof input.at === "number" ? input.at : undefined,
      );
    },
    /**
     * A requirement is posted to the group first (durable, visible), then the leader
     * plans asynchronously: the caller returns immediately, so the group never waits.
     */
    cancel: (groupId, workId) => runtimeFor(groupId).scheduler.cancel(groupId, workId, ctx),
    addMember: async (groupId, botId) => {
      const runtime = runtimeFor(groupId);
      if (!botRegistry.get(botId)) throw new Error(`unknown bot: ${botId}`);
      const doc = await groupStore.get(groupId, ctx);
      if (!doc) throw new Error(`unknown group: ${groupId}`);
      if (doc.roster.includes(botId)) return { botId, already: true };
      const { conversationId } = await groupStore.addMember(groupId, botId, ctx);
      await runtime.attachBot(botId, conversationId, ctx);
      runtime.doc = await groupStore.get(groupId, ctx);
      emitGroups();
      notifyGroup(groupId);
      return { botId, already: false };
    },
    removeMember: async (groupId, botId) => {
      const runtime = runtimeFor(groupId);
      // The leader owns planning for the group; without it a requirement has nobody to split it.
      if (botRegistry.leader()?.id === botId) throw new Error("cannot remove the leader");
      const doc = await groupStore.get(groupId, ctx);
      if (!doc) throw new Error(`unknown group: ${groupId}`);
      if (!doc.roster.includes(botId)) return { botId, removed: false };
      if (await runtime.activity.isBusy(botId, ctx)) throw new Error(`bot busy: ${botId}`);
      await groupStore.removeMember(groupId, botId, ctx);
      runtime.detachBot(botId);
      runtime.doc = await groupStore.get(groupId, ctx);
      emitGroups();
      notifyGroup(groupId);
      return { botId, removed: true };
    },
    /**
     * Shared group context: an announcement and a pin list. Both are injected into every
     * bot's prompt by `groupContext`, so editing them changes what the team knows — but
     * never starts a run.
     */
    setAnnouncement: async (groupId, text) => {
      runtimeFor(groupId);
      await groupStore.setAnnouncement(groupId, String(text ?? "").trim(), ctx);
      notifyGroup(groupId);
      return api.groupDetail(groupId);
    },
    addPin: async (groupId, input) => {
      runtimeFor(groupId);
      const text = String(input?.text ?? "").trim();
      if (!text) throw new Error("pin text is required");
      await groupStore.addPin(groupId, { text, by: String(input?.by ?? "我") }, ctx);
      notifyGroup(groupId);
      return api.groupDetail(groupId);
    },
    removePin: async (groupId, pinId) => {
      runtimeFor(groupId);
      if (!pinId) throw new Error("pinId is required");
      await groupStore.removePin(groupId, String(pinId), ctx);
      notifyGroup(groupId);
      return api.groupDetail(groupId);
    },
    /**
     * One archived deliverable, for the download route. Only files the artifact actually
     * lists are served: the archive directory is never a browsable directory.
     */
    fileFor: async (groupId, workId, relative) => {
      runtimeFor(groupId);
      const artifact = await artifacts.get(artifacts.idFor(workId), ctx);
      if (!artifact) throw new Error(`unknown work: ${workId}`);
      const known = (artifact.files ?? []).some((file) => file.path === relative);
      if (!known) throw new Error(`unknown file: ${relative}`);
      return workspace.readArchive(groupId, workId, relative);
    },
    /**
     * The whole group's history as one file: markdown for a person, JSON for an archive.
     * Everything comes from durable entries, so an export after a restart is identical.
     */
    exportGroup: async (groupId, format = "md") => {
      runtimeFor(groupId);
      const doc = await groupStore.get(groupId, ctx);
      const pin = await groupStore.pin(groupId, ctx);
      const nameOf = (id) => botRegistry.get(id)?.name ?? String(id ?? "");
      const all = [];
      let cursor;
      for (;;) {
        const page = await items(groupId, { limit: 500, before: cursor });
        if (!page) break;
        all.unshift(...page.items);
        if (!page.next) break;
        cursor = page.next;
      }
      const exportedAt = Date.now();
      const announcement = pin.announcement ?? "";
      const pins = (pin.pins ?? []).map((item) => ({ text: item.text, by: item.by, at: item.at }));
      const stamp = new Date(exportedAt);
      const pad = (n) => String(n).padStart(2, "0");
      const clock = (at) =>
        `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
      const hhmm = (at) => {
        const d = new Date(at);
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const dayOf = (at) => {
        const d = new Date(at);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      };
      const safeName = String(doc?.name ?? groupId).replace(/[\\/:*?"<>|\s]+/g, "-");
      const filename = `musebot-${safeName}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(
        stamp.getHours(),
      )}${pad(stamp.getMinutes())}.${format === "json" ? "json" : "md"}`;

      if (format === "json") {
        const payload = {
          exportedAt,
          group: { id: groupId, name: doc?.name ?? groupId, roster: [...(doc?.roster ?? [])], createdAt: doc?.createdAt ?? 0 },
          members: (doc?.roster ?? []).map((id) => ({ id, name: nameOf(id) })),
          announcement,
          pins,
          items: all,
        };
        return { filename, contentType: "application/json; charset=utf-8", content: JSON.stringify(payload, null, 2) };
      }

      const lines = [];
      lines.push(`# ${doc?.name ?? groupId} · 聊天归档`, "");
      lines.push(`- 导出时间:${clock(exportedAt)}`);
      lines.push(`- 群 ID:${groupId}`);
      lines.push(`- 成员:${(doc?.roster ?? []).map((id) => nameOf(id)).join("、") || "(空)"}`);
      lines.push(`- 消息条数:${all.length}`);
      lines.push("", "## 群公告", "", announcement.trim() || "(空)", "");
      lines.push("## 群置顶", "");
      if (pins.length === 0) lines.push("(空)");
      for (const item of pins) lines.push(`- ${item.text} — ${item.by || "?"} · ${clock(Number(item.at) || exportedAt)}`);
      lines.push("", "## 聊天记录", "");
      let lastDay = "";
      for (const entry of all) {
        const data = entry.data ?? {};
        const at = typeof data.at === "number" ? data.at : undefined;
        if (at) {
          const day = dayOf(at);
          if (day !== lastDay) {
            lines.push("", `### ${day}`, "");
            lastDay = day;
          }
        }
        const when = at ? hhmm(at) : "--:--";
        if (entry.kind === "chat.message") {
          const author = data.author ?? {};
          lines.push(`**${when} ${author.name ?? author.id ?? "?"}**:${String(data.text ?? "").trim()}`);
          continue;
        }
        const ev = String(data.ev ?? "event");
        const subject = String(data.subject ?? "");
        if (ev === "plan") {
          lines.push(`**${when} ${nameOf(data.by) || "领导"}** 分工:`);
          for (const item of data.items ?? []) {
            const deps = Array.isArray(item.deps) && item.deps.length ? `(需要 ${item.deps.join("、")})` : "";
            lines.push(`- ${item.key} @${nameOf(item.preferAssignee) || item.capability} ${item.subject}${deps}`);
          }
          continue;
        }
        if (ev === "delivered") {
          const art = data.artifact ?? {};
          lines.push(`**${when} ${nameOf(data.botId)}** 交付「${subject || art.title || "任务"}」`, "");
          const body = String(art.body ?? "").trim();
          if (body) lines.push(body, "");
          const files = Array.isArray(art.files) ? art.files : [];
          if (files.length) {
            lines.push("附件:");
            for (const file of files) lines.push(`- \`${file.path}\` (${file.bytes ?? 0} B)`);
            lines.push("");
          }
          continue;
        }
        if (ev === "assigned" || ev === "done") continue;
        const extra = data.reason || data.error ? `:${data.reason || data.error}` : "";
        lines.push(`- _${when} ${ev}${subject ? `「${subject}」` : ""}${extra}_`);
      }
      lines.push("");
      return { filename, contentType: "text/markdown; charset=utf-8", content: lines.join("\n") };
    },
    /** Rename the group; the roster and every conversation stay as they are. */
    renameGroup: async (groupId, name) => {
      const runtime = runtimeFor(groupId);
      const next = String(name ?? "").trim();
      if (!next) throw new Error("name is required");
      if (next.length > 40) throw new Error("name is too long");
      await groupStore.setName(groupId, next, ctx);
      runtime.doc = await groupStore.get(groupId, ctx);
      emitGroups();
      notifyGroup(groupId);
      return api.groupDetail(groupId);
    },
    /** What the settings panel shows: the effective config, the key masked. */
    getSettings: () => settingsView(),
    /**
     * Save a new model endpoint. Empty apiKey means "keep the stored one", so the panel
     * never has to send the secret back to the page.
     */
    updateSettings: async (input) => {
      const current = await settingsStore.get(ctx);
      const api = String(input?.api ?? current.api);
      if (!API_KINDS.includes(api)) throw new Error(`unknown api: ${api}`);
      const baseUrl = String(input?.baseUrl ?? current.baseUrl).trim();
      if (!/^https?:\/\//i.test(baseUrl)) throw new Error("baseUrl must start with http(s)://");
      const modelId = String(input?.modelId ?? current.modelId).trim();
      if (!modelId) throw new Error("modelId is required");
      const typedKey = String(input?.apiKey ?? "").trim();
      const apiKey = typedKey && !typedKey.includes("…") ? typedKey : current.apiKey;
      if (!apiKey) throw new Error("apiKey is required");
      const saved = await settingsStore.set({ api, baseUrl, modelId, apiKey }, ctx);
      await applyModel(saved);
      return settingsView();
    },
    /**
     * Network facts for the 手机和设备 page: where we listen, which URLs a phone could use,
     * and what Tailscale reports. The bind address change only takes effect on restart.
     */
    network: async () => {
      const current = await settingsStore.get(ctx);
      return {
        host: current.host,
        hosts: HOST_CHOICES,
        lan: lanAddresses(),
        tailscale: { ...(await tailscaleStatus()), serve: await serveStatus() },
      };
    },
    /** Open the local port on the tailnet (HTTPS when the tailnet has certs, else HTTP). */
    enableServe: async () => {
      const port = opts.port ?? Number(process.env.PORT ?? 18800);
      return { ...(await enableServe(port)), port };
    },
    /** Close it again — but never wipe a serve config that is not ours. */
    disableServe: async () => {
      const port = opts.port ?? Number(process.env.PORT ?? 18800);
      return disableServe(port);
    },
    /** Persist the bind address; the caller (server) decides whether to warn about a restart. */
    updateNetwork: async (input) => {
      const host = String(input?.host ?? "");
      if (!isHostChoice(host)) throw new Error(`host must be one of ${HOST_CHOICES.join(", ")}`);
      const current = await settingsStore.get(ctx);
      const saved = await settingsStore.set(
        { api: current.api, baseUrl: current.baseUrl, modelId: current.modelId, apiKey: current.apiKey, host },
        ctx,
      );
      return { host: saved.host, hosts: HOST_CHOICES, restartRequired: true };
    },
    /** A real reachability probe against the saved endpoint (no tokens spent). */
    checkSettings: async () => {
      const current = await settingsStore.get(ctx);
      const started = Date.now();
      const base = current.baseUrl.replace(/\/+$/, "");
      const url =
        current.api === "anthropic-messages"
          ? `${base}/models`
          : current.api === "google-generative-ai"
            ? `${base}/models?key=${encodeURIComponent(current.apiKey)}`
            : `${base}/models`;
      const headers =
        current.api === "anthropic-messages"
          ? { "x-api-key": current.apiKey, "anthropic-version": "2023-06-01" }
          : current.api === "google-generative-ai"
            ? {}
            : { authorization: `Bearer ${current.apiKey}` };
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
        const text = await res.text();
        let models = [];
        try {
          const parsed = JSON.parse(text);
          models = (parsed.data ?? parsed.models ?? []).map((row) => row.id ?? row.name).filter(Boolean);
        } catch {
          /* a gateway may answer HTML; reachability is what matters */
        }
        return {
          ok: res.ok,
          status: res.status,
          latencyMs: Date.now() - started,
          modelListed: models.length ? models.some((id) => String(id).includes(current.modelId)) : undefined,
          models: models.slice(0, 8),
          detail: res.ok ? `${models.length} 个模型可用` : text.slice(0, 160),
        };
      } catch (error) {
        return { ok: false, status: 0, latencyMs: Date.now() - started, detail: String(error?.message ?? error) };
      }
    },
    /** Process facts for the 运行状态 page — all measured, nothing invented. */
    status: async () => {
      const current = await settingsStore.get(ctx);
      return {
        mode: opts.readOnly === true ? "viewer" : "writer",
        startedAt,
        storage: opts.storageFile ?? ":memory:",
        archiveRoot: workspace.archiveRoot,
        archive: await workspace.stats(),
        groups: (await groupStore.list(ctx)).length,
        bots: bots.length,
        model: { provider: "musebot", modelId: current.modelId, api: current.api, baseUrl: current.baseUrl, source: current.source },
        version: "0.4.1",
        readonly: opts.readOnly === true,
      };
    },
    /**
     * One bot's panel: identity, effective prompt/model (override vs default), its busy
     * state, and what it has delivered in this group. Everything is read from durable state.
     */
    botProfile: async (groupId, botId) => {
      const runtime = runtimeFor(groupId);
      const bot = botRegistry.get(botId);
      if (!bot) throw new Error(`unknown bot: ${botId}`);
      const override = await profiles.get(groupId, botId, ctx);
      const settings = await settingsStore.get(ctx);
      const rows = await graph.list(groupId, ctx);
      const delivered = [];
      for (const row of rows) {
        if (row.assignee !== botId || !row.artifactId) continue;
        const artifact = await artifacts.get(row.artifactId, ctx).catch(() => undefined);
        delivered.push({
          workId: row.id,
          key: row.key,
          subject: row.subject,
          status: row.status,
          at: artifact?.files ? undefined : undefined,
          files: (artifact?.files ?? []).map((file) => ({ path: file.path, bytes: file.bytes })),
        });
      }
      const groups = [];
      for (const doc of await groupStore.list(ctx)) {
        if (doc.roster.includes(botId)) groups.push({ id: doc.id, name: doc.name });
      }
      const memory = await memoryStore.get(groupId, botId, ctx);
      return {
        groupId,
        id: botId,
        name: bot.name,
        defaultName: botDefaults.get(botId)?.name ?? bot.name,
        role: bot.role ?? "worker",
        capabilities: bot.capabilities ?? [],
        busy: await runtime.activity.isBusy(botId, ctx),
        conversationId: runtime.conversationIdFor(botId) ?? null,
        avatar: bot.avatar ?? "",
        custom: bot.custom === true,
        instructions: { default: bot.agent.instructions, override: override.instructions, effective: override.instructions || bot.agent.instructions, updatedAt: override.updatedAt },
        model: { global: settings.modelId, override: override.model, effective: override.model || settings.modelId },
        // Summary only; the full list has its own endpoint.
        memory: { enabled: memory.enabled, count: memory.items.length },
        groups,
        delivered: delivered.slice(-8).reverse(),
        // The real tool list bots get, in stable order; the bot panel shows the same names.
        tools: ["read", "write_file", "bash"],
        // Built-in pi tools stay internal; the UI shows installed skills and their toggles.
        skills: (await skillStore.enabledFor(botId, ctx)).map((skill) => skill.name),
        skillsAvailable: (await skillStore.list()).map(({ name, description, source }) => ({ name, description, source })),
      };
    },
    /** Save a bot's prompt/model override for this group and apply it immediately. */
    updateBotProfile: async (groupId, botId, input) => {
      const runtime = runtimeFor(groupId);
      const bot = botRegistry.get(botId);
      if (!bot) throw new Error(`unknown bot: ${botId}`);
      const instructions = String(input?.instructions ?? "").trim();
      const model = String(input?.model ?? "").trim();
      const name = input?.name === undefined ? undefined : String(input.name ?? "").trim();
      const avatar = input?.avatar === undefined ? undefined : input.avatar;
      if (instructions.length > 4000) throw new Error("instructions is too long (max 4000)");
      if (model && !/^[\w./:-]+$/.test(model)) throw new Error(`invalid model id: ${model}`);
      if (name !== undefined && !name) throw new Error("bot name is required");
      if (name !== undefined || avatar !== undefined) {
        const identity = await botIdentities.set(botId, { name, avatar }, ctx);
        const fallback = botDefaults.get(botId) ?? { name: bot.name, avatar: bot.avatar ?? "" };
        const nextName = identity.name || fallback.name;
        const nextAvatar = identity.avatar || fallback.avatar || "";
        bot.name = nextName;
        bot.avatar = nextAvatar;
      }
      await profiles.set(groupId, botId, { instructions, model }, ctx);
      await runtime.reconfigureBot(botId, ctx);
      return api.botProfile(groupId, botId);
    },
    /** Long-term memory for one bot in one group. Reads are cheap; writes return the new list. */
    getMemory: async (groupId, botId) => {
      runtimeFor(groupId);
      if (!botRegistry.get(botId)) throw new Error(`unknown bot: ${botId}`);
      return memoryStore.get(groupId, botId, ctx);
    },
    addMemory: async (groupId, botId, input) => {
      runtimeFor(groupId);
      if (!botRegistry.get(botId)) throw new Error(`unknown bot: ${botId}`);
      return memoryStore.add(groupId, botId, input, ctx);
    },
    removeMemory: async (groupId, botId, memId) => {
      runtimeFor(groupId);
      if (!botRegistry.get(botId)) throw new Error(`unknown bot: ${botId}`);
      if (!memId) throw new Error("memory id is required");
      return memoryStore.remove(groupId, botId, String(memId), ctx);
    },
    setMemoryEnabled: async (groupId, botId, enabled) => {
      runtimeFor(groupId);
      if (!botRegistry.get(botId)) throw new Error(`unknown bot: ${botId}`);
      return memoryStore.setEnabled(groupId, botId, enabled !== false, ctx);
    },
    clearMemory: async (groupId, botId) => {
      runtimeFor(groupId);
      if (!botRegistry.get(botId)) throw new Error(`unknown bot: ${botId}`);
      return memoryStore.clear(groupId, botId, ctx);
    },
    /** Installed skills for the bot panel: name, description and origin only. */
    listSkills: async () => ({
      skills: (await skillStore.list()).map(({ name, description, source }) => ({ name, description, source })),
    }),
    /** Toggle one skill for one bot; answers with the same skill view as botProfile. */
    setBotSkill: async (groupId, botId, input) => {
      runtimeFor(groupId);
      if (!botRegistry.get(botId)) throw new Error(`unknown bot: ${botId}`);
      const skills = await skillStore.setEnabled(botId, input?.name, input?.enabled !== false, ctx);
      return {
        skills,
        skillsAvailable: (await skillStore.list()).map(({ name, description, source }) => ({ name, description, source })),
      };
    },
    /** Candidates the members sheet can offer; the roster itself comes from groupDetail. */
    botsList: () =>
      bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        role: bot.role ?? "worker",
        capabilities: bot.capabilities ?? [],
        avatar: bot.avatar ?? "",
        custom: bot.custom === true,
      })),
    /** What a new-bot form may choose from; the server validates against the same list. */
    botCapabilities: () => [...BOT_CAPABILITIES],
    /**
     * Create a bot from the UI. It joins the live registry immediately; when `groupId` is
     * supplied it also joins that group in the same call, so there is no half-created bot.
     */
    createBot: async (input) => {
      const groupId = String(input?.groupId ?? "").trim();
      if (groupId) runtimeFor(groupId);
      const wantedName = String(input?.name ?? "").trim();
      if (bots.some((candidate) => candidate.name === wantedName)) {
        throw new Error(`bot name already exists: ${wantedName}`);
      }
      const bot = await customBots.create(input, ctx);
      bot.agent.model = bots[0]?.agent.model ?? model;
      botDefaults.set(bot.id, { name: bot.name, avatar: bot.avatar ?? "" });
      botRegistry.add(bot);
      let added = false;
      if (groupId) {
        const result = await api.addMember(groupId, bot.id);
        added = !result.already;
      }
      return {
        bot: {
          id: bot.id,
          name: bot.name,
          role: bot.role,
          capabilities: [...bot.capabilities],
          avatar: bot.avatar ?? "",
          custom: true,
        },
        added,
      };
    },
    /** Personal profile: nickname, signature, avatar. Shared by every group and device. */
    getProfile: () => profileStore.get(ctx),
    updateProfile: (input) => profileStore.set(input, ctx),
    /**
     * Talking is the only input. A message that reads like a request goes to the leader;
     * everything else is a plain chat line. This is what the web UI's single 发送 button uses.
     */
    chat: async (groupId, input) => {
      const text = String(input.text ?? "").trim();
      if (!text) return undefined;
      // A DM never routes: its roster bot is the only addressee, task request or not.
      if (runtimes.get(groupId)?.doc?.type === "dm") return dmDeliver(groupId, text, input.author, input.at);
      const decision = await router.route({ text, mentions: mentionsIn(text) }, ctx);
      if (decision.respond && decision.speaker.kind === "leader") {
        return api.requirement(groupId, text, input.author);
      }
      return api.send(groupId, input);
    },
    requirement: async (groupId, text, author) => {
      const runtime = runtimeFor(groupId);
      const requirement = String(text ?? "").trim();
      if (!requirement) return undefined;
      // A DM dispatches the line straight to its bot: no planning work.event, no leader.
      if (runtime.doc.type === "dm") return dmDeliver(groupId, requirement, author);
      await runtime.channel.speak(requirement, author ?? { type: "human", id: "u1", name: "我" }, ctx);
      await runtime.channel.append({ kind: "work.event", data: { ev: "planning", by: botRegistry.leader()?.id ?? "leader" } }, ctx);
      void (async () => {
        try {
          // Only this group's members are candidates: a plan naming an absent bot would block.
          const rosterBots = runtime.members().map((id) => botRegistry.get(id)).filter(Boolean);
          const plan = await planner.plan(groupId, requirement, rosterBots, ctx);
          await runtime.scheduler.submitPlan(plan, ctx);
        } catch (error) {
          await runtime.channel
            .append({ kind: "work.event", data: { ev: "failed", error: String(error?.message ?? error) } }, ctx)
            .catch(() => undefined);
        }
      })();
      return undefined;
    },
    waitIdle: () => harness.waitForIdle(ctx),
    close: () => harness.close(ctx),
  };
  // A saved model config wins over the environment. It must run after `applyModel` exists,
  // and before the process accepts work, so every conversation is configured consistently.
  if (opts.readOnly !== true && opts.model?.provider !== "faux") {
    const stored = await settingsStore.get(ctx);
    if (stored.source === "settings") await applyModel(stored).catch(() => undefined);
  }

  return api;
}
