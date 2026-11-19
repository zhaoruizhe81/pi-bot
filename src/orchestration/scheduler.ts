import { validatePlan, topoOrder } from "../protocol/plan.ts";
import { planCard } from "../publish/workCards.ts";

export function createScheduler(deps) {
  return {
    async submitPlan(plan, ctx) {
      const check = validatePlan(plan);
      if (!check.ok) {
        await deps.channel.append(
          { kind: "work.event", data: { ev: "blocked", workId: plan.id, reason: `cycle: ${check.cycle.join(" -> ")}` } },
          ctx,
        );
        throw new Error(`plan has a dependency cycle: ${check.cycle.join(" -> ")}`);
      }

      const order = topoOrder(plan);
      const taskIds = {};
      const orch = await deps.harness.conversation(deps.orchConversationId, ctx);
      if (!orch) throw new Error("orchestration conversation missing");

      await orch.commit(async (tx) => {
        for (const item of order) {
          const depTaskIds = item.deps.map((k) => taskIds[k]);
          const taskId = await tx.createTask(
            deps.workItemTask,
            {
              workItemId: deps.graph.workItemId(plan.id, item.key),
              planId: plan.id,
              key: item.key,
              groupId: plan.groupId,
              subject: item.subject,
              capability: item.capability,
              requirement: plan.requirement,
              depKeys: [...item.deps],
              depWorkIds: item.deps.map((key) => deps.graph.workItemId(plan.id, key)),
              depTaskIds,
            },
            { ownership: { kind: "conversation" }, background: true },
          );
          taskIds[item.key] = taskId;
        }
        return null;
      }, ctx);

      const rows = await deps.graph.syncPlan(plan, taskIds, ctx);
      const workIds = Object.fromEntries(
        rows.filter((row) => row.planId === plan.id).map((row) => [row.key, row.id]),
      );
      await deps.channel.append(planCard(plan, deps.leaderId, workIds), ctx);
      return deps.graph.list(plan.groupId, ctx);
    },
    async dispatchReady(_ctx) {
      // WorkItemTask self-polls for an idle bot, so there is nothing to wake centrally in M1.
    },
    /** Ask the durable task to stop; it writes the cancelled card itself in its abort phase. */
    async cancel(groupId, workId, ctx) {
      const rows = await deps.graph.list(groupId, ctx);
      const row = rows.find((candidate) => candidate.id === workId);
      if (!row) return { status: "not_found", workId };
      if (["done", "failed", "cancelled"].includes(row.status)) return { status: "terminal", workId, workStatus: row.status };
      if (!row.taskId) return { status: "not_found", workId };
      // TaskId is a number; the graph stores it as a string.
      const result = await deps.harness.abortTask(Number(row.taskId), ctx);
      // Stopping the task is not enough: the bot is still generating. Single-threaded per
      // group, so aborting that conversation only touches the cancelled work.
      if (row.assignee) {
        const conversationId = deps.conversationIdFor?.(row.assignee);
        const conv = conversationId ? await deps.harness.conversation(conversationId, ctx) : undefined;
        await conv?.abort(ctx).catch(() => undefined);
      }
      return { status: result, workId };
    },
  };
}
