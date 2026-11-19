import { defineTask, SubmissionSettled } from "@earendil-works/pi-durable";
import { assignedCard, startedCard, deliveredCard, doneCard, failedCard, cancelledCard, blockedCard } from "../publish/workCards.ts";
import { readAnswer } from "../publish/answer.ts";

const MAX_UPSTREAM = 1500;

/** The prompt a bot receives: the requirement, its own slice, and what upstream delivered. */
async function composePrompt(task, group, ctx) {
  const lines = [`需求:${task.input.requirement || "(未提供)"}`, `你负责的任务:${task.input.subject}`];
  const depIds = task.input.depWorkIds ?? [];
  if (depIds.length > 0) {
    const rows = await group.graph.list(task.input.groupId, ctx);
    const parts = [];
    for (const depId of depIds) {
      const row = rows.find((candidate) => candidate.id === depId);
      if (!row?.artifactId) continue;
      const artifact = await group.artifacts.get(row.artifactId, ctx);
      if (artifact?.body) parts.push(`- ${row.key} ${row.subject}:\n${artifact.body.slice(0, MAX_UPSTREAM)}`);
    }
    if (parts.length > 0) lines.push("上游交付:", ...parts);
  }
  lines.push("直接给出可交付的结论/成品,不要复述任务,也不要反问。");
  return lines.join("\n\n");
}

/** Card reasons are read by people, so map the internal codes once, here. */
const reasonText = (reason) =>
  ({
    "no idle bot": "没有空闲的 bot",
    "a dependency failed": "依赖的任务失败",
    "bot conversation missing": "bot 会话丢失",
    unanswered: "模型没有给出回答",
    model_error: "模型调用失败",
    aborted: "已中止",
  })[reason] ?? String(reason ?? "未知原因");

const cardWi = (task, extra = {}) => ({
  id: task.input.workItemId,
  key: task.input.key,
  subject: task.input.subject,
  assignee: extra.assignee,
  /** Plan keys, so the group reads `W1` instead of an internal work-item id. */
  deps: task.input.depKeys ?? [],
  status: extra.status ?? "running",
});

/**
 * One durable task per WorkItem: wait_deps -> dispatch -> publish.
 * Execution detail stays in the bot's private conversation; the group only gets cards.
 * The owning group is resolved from `input.groupId`, so one definition serves every group.
 */
export function createWorkItemTask(deps) {
  /** Terminal failure: one card, one graph transition, one commit. */
  const fail = (task, rt, group, ctx, error) =>
    rt.commit(
      async (tx) => {
        await tx.appendEntry(
          group.groupConversationId,
          failedCard(cardWi(task, { assignee: task.state.checkpoint?.botId }), error),
        );
        await group.graph.transition(tx, task.input.groupId, task.input.workItemId, "failed", {
          blockedReason: String(error),
        });
        return { status: "terminal", outcome: { status: "completed", result: { failed: true, error } } };
      },
      ctx,
    );

  return defineTask({
    name: "musebot.work-item",
    version: 1,
    initial: () => ({ phase: "wait_deps" }),
    phases: {
      wait_deps: async (task, rt, ctx) => {
        const depTaskIds = task.input.depTaskIds ?? [];
        if (depTaskIds.length === 0) {
          await rt.commit(() => ({ status: "running", checkpoint: { phase: "dispatch" } }), ctx);
          return;
        }
        await rt.commit(
          () => ({ status: "waiting", on: depTaskIds, policy: "allSettled", checkpoint: { phase: "dispatch" } }),
          ctx,
        );
      },

      dispatch: async (task, rt, ctx) => {
        const cp = task.state.checkpoint ?? {};
        const group = deps.resolveGroup(task.input.groupId);
        const depTaskIds = task.input.depTaskIds ?? [];
        if (depTaskIds.length > 0) {
          const outcomes = await rt.outcomes(depTaskIds, ctx);
          if (outcomes.some((o) => o.status !== "completed")) {
            await fail(task, rt, group, ctx, reasonText("a dependency failed"));
            return;
          }
        }

        const botId = await group.activity.chooseIdle(task.input.capability, ctx);
        if (!botId) {
          await rt.commit(async (tx) => {
            if (!cp.blockedNotified) {
              await tx.appendEntry(
                group.groupConversationId,
                blockedCard(cardWi(task, { assignee: cp.botId }), reasonText("no idle bot")),
              );
              await group.graph.transition(tx, task.input.groupId, task.input.workItemId, "blocked", {
                blockedReason: "no idle bot",
              });
            }
            return {
              status: "sleeping",
              until: rt.now() + (deps.retryMs ?? 2000),
              checkpoint: { phase: "dispatch", blockedNotified: true },
            };
          }, ctx);
          return;
        }

        const conv = await group.conversationFor(botId, ctx);
        if (!conv) {
          await fail(task, rt, group, ctx, reasonText("bot conversation missing"));
          return;
        }

        // A fresh scratch dir per dispatch: whatever lands there is this work item's deliverable.
        await group.workspace?.reset(conv.id);
        const content = await composePrompt(task, group, ctx);
        await conv.submit(
          {
            type: "input",
            content,
            requestId: `work:${task.input.workItemId}`,
            notify: { taskId: rt.taskId, key: "answer" },
          },
          ctx,
        );

        const wi = cardWi(task, { assignee: botId, status: "running" });
        await rt.commit(async (tx) => {
          await tx.appendEntry(group.groupConversationId, assignedCard(wi));
          await tx.appendEntry(group.groupConversationId, startedCard(wi));
          await group.graph.transition(tx, task.input.groupId, task.input.workItemId, "running", {
            assignee: botId,
            blockedReason: "",
          });
          return {
            status: "sleeping",
            signals: [SubmissionSettled.key("answer")],
            checkpoint: { phase: "publish", botId },
          };
        }, ctx);
      },

      publish: async (task, rt, ctx) => {
        const group = deps.resolveGroup(task.input.groupId);
        const botId = task.state.checkpoint?.botId;
        const state = await rt.readSignal(SubmissionSettled, "answer", ctx);
        const settled = state && "value" in state ? state.value : undefined;

        if (settled && settled.status === "done") {
          // The model's own answer becomes the artifact the group sees; the canned
          // line is only a fallback for an empty reply.
          const conv = await group.conversationFor(botId, ctx);
          const answer = conv ? await readAnswer(conv, ctx) : "";
          const body = answer || `由 ${botId} 交付:${task.input.subject}`;
          const conversationId = group.conversationIdFor(botId);
          // Scratch is wiped by the bot's next dispatch, so publish copies the deliverables
          // into the group archive and lists *that*: the download links must outlive the run.
          const archived = conversationId
            ? await group.workspace?.archive(task.input.groupId, task.input.workItemId, conversationId) ?? []
            : [];
          const files = archived.map((file) => ({ path: file.path, bytes: file.bytes, preview: file.preview ?? "" }));
          const artifactId = await group.artifacts.put(
            { workItemId: task.input.workItemId, botId, kind: "text", title: task.input.subject, body, files },
            ctx,
          );
          const wi = cardWi(task, { assignee: botId, status: "delivered" });
          const artifact = { id: artifactId, workItemId: task.input.workItemId, botId, kind: "text", title: task.input.subject, body, files };
          await rt.commit(async (tx) => {
            await tx.appendEntry(group.groupConversationId, deliveredCard(wi, artifact));
            await tx.appendEntry(group.groupConversationId, doneCard(cardWi(task, { assignee: botId, status: "done" })));
            await group.graph.transition(tx, task.input.groupId, task.input.workItemId, "delivered", { artifactId });
            await group.graph.transition(tx, task.input.groupId, task.input.workItemId, "done", {});
            return { status: "terminal", outcome: { status: "completed", result: { artifactId } } };
          }, ctx);
          // Long-term memory is a best-effort side effect of a successful delivery: a failed
          // extraction must never turn a delivered task into a failure.
          try {
            await deps.onDelivered?.({
              groupId: task.input.groupId,
              botId,
              requirement: task.input.requirement ?? "",
              subject: task.input.subject ?? "",
              body,
            });
          } catch {
            /* memory extraction is optional */
          }
          return;
        }

        const reason = settled ? reasonText(settled.reason ?? "unanswered") : "没有收到结算信号";
        await fail(task, rt, group, ctx, reason);
      },
    },
    abort: async (task, rt, ctx) => {
      const group = deps.resolveGroup(task.input.groupId);
      await rt.commit(async (tx) => {
        await tx.appendEntry(
          group.groupConversationId,
          cancelledCard(cardWi(task, {}), "已取消"),
        );
        await group.graph.transition(tx, task.input.groupId, task.input.workItemId, "cancelled", {
          blockedReason: "已取消",
        });
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
    },
  });
}
