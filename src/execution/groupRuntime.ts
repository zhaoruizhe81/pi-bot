// One group's runtime: its conversations, channel, busyness view, and scheduler.
// Everything here is rebuilt from durable documents on open, so a restart reuses the
// same conversations instead of minting a fresh history.
import { createBotActivity } from "../state/botActivity.ts";
import { createGroupChannel } from "../publish/groupChannel.ts";
import { createScheduler } from "../orchestration/scheduler.ts";

export async function openGroupRuntime(deps) {
  const { doc, harness, botRegistry, graph, artifacts, workItemTask, workspace, profiles, configureBots = true, ctx } = deps;

  // ConversationId is a number; documents store it as a string.
  const groupConv = await harness.conversation(Number(doc.groupConversationId), ctx);
  if (!groupConv) throw new Error(`group ${doc.id}: blackboard conversation ${doc.groupConversationId} is gone`);

  const botConversations = new Map();
  /**
   * A bot's per-group profile may override the prompt and the model; everything else comes
   * from the static bot config. Idempotent: re-running writes the same values.
   */
  const configureBot = async (botId, conv) => {
    const bot = botRegistry.get(botId);
    if (!bot || !configureBots) return;
    const override = profiles ? await profiles.get(doc.id, botId, ctx) : { instructions: "", model: "" };
    const instructions = override.instructions || bot.agent.instructions;
    const model = override.model ? { provider: bot.agent.model.provider, modelId: override.model } : bot.agent.model;
    await conv.configure({ model, instructions }, ctx);
  };
  for (const botId of doc.roster) {
    const conversationId = doc.botConversations[botId];
    const conv = conversationId ? await harness.conversation(Number(conversationId), ctx) : undefined;
    if (!conv) {
      // A roster entry without a conversation cannot work; skip it instead of failing the group.
      console.warn(`group ${doc.id}: bot ${botId} has no conversation, skipped`);
      continue;
    }
    await configureBot(botId, conv);
    botConversations.set(botId, conv.id);
  }

  const conversationIdFor = (botId) => botConversations.get(botId);
  const activity = createBotActivity(harness, botRegistry, conversationIdFor, (botId) => botConversations.has(botId));
  const channel = createGroupChannel(harness, groupConv.id);

  const runtime = {
    groupId: doc.id,
    doc,
    groupConversationId: groupConv.id,
    orchConversationId: Number(doc.orchConversationId),
    conversationIdFor,
    conversationFor: (botId, context) => {
      const id = conversationIdFor(botId);
      return id ? harness.conversation(id, context) : Promise.resolve(undefined);
    },
    activity,
    channel,
    graph,
    artifacts,
    workspace,
    /** Re-apply the profile after the settings panel edits it. */
    async reconfigureBot(botId, context) {
      const id = conversationIdFor(botId);
      if (!id) return;
      const conv = await harness.conversation(id, context);
      if (conv) await configureBot(botId, conv);
    },
    /** Join: attach an existing (or freshly minted) conversation to this group's runtime. */
    async attachBot(botId, conversationId, context) {
      const conv = await harness.conversation(conversationId, context);
      if (!conv) throw new Error(`group ${doc.id}: conversation ${conversationId} is gone`);
      await configureBot(botId, conv);
      botConversations.set(botId, conv.id);
      return conv.id;
    },
    detachBot(botId) {
      botConversations.delete(botId);
    },
    members() {
      return [...botConversations.keys()];
    },
  };

  runtime.scheduler = createScheduler({
    harness,
    registry: botRegistry,
    activity,
    graph,
    artifacts,
    channel,
    workItemTask,
    conversationIdFor,
    orchConversationId: runtime.orchConversationId,
    groupConversationId: runtime.groupConversationId,
    leaderId: botRegistry.leader()?.id,
  });

  return runtime;
}
