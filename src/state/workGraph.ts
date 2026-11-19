// Durable per-group projection of the work graph (M2). The authoritative state of a
// WorkItem is still its task; this document is what the UI and the leader read.
import { WorkGraph } from "./docs.ts";

const workItemId = (planId, key) => `w-${planId}-${key}`;

const blankRow = (plan, item) => ({
  id: workItemId(plan.id, item.key),
  planId: plan.id,
  key: item.key,
  groupId: plan.groupId,
  subject: item.subject,
  capability: item.capability,
  assignee: item.preferAssignee ?? "",
  deps: item.deps.map((dep) => workItemId(plan.id, dep)),
  status: item.deps.length > 0 ? "blocked" : "queued",
  blockedReason: "",
  artifactId: "",
  taskId: "",
});

/** JSON row -> domain value: empty strings mean "absent". */
export const toWorkItem = (row) => ({
  id: row.id,
  planId: row.planId,
  key: row.key,
  groupId: row.groupId,
  subject: row.subject,
  capability: row.capability,
  assignee: row.assignee || undefined,
  deps: [...row.deps],
  status: row.status,
  blockedReason: row.blockedReason || undefined,
  artifactId: row.artifactId || undefined,
  taskId: row.taskId || undefined,
});

export function createWorkGraph(harness) {
  return {
    workItemId,

    async list(groupId, ctx) {
      const doc = await harness.snapshot(WorkGraph, groupId, ctx);
      return (doc?.items ?? []).map(toWorkItem);
    },

    async get(groupId, id, ctx) {
      const items = await this.list(groupId, ctx);
      return items.find((item) => item.id === id);
    },

    /**
     * Mutate the group's rows inside the caller's commit, so a task's cards, its own
     * state, and the graph move together.
     */
    async mutate(tx, groupId, fn) {
      const doc = await tx.doc(WorkGraph, groupId, null);
      fn(doc.items);
      return null;
    },

    /** Apply a status transition inside the caller's commit. */
    async transition(tx, groupId, id, to, patch) {
      await this.mutate(tx, groupId, (items) => {
        const row = items.find((item) => item.id === id);
        if (!row) return;
        Object.assign(row, patch ?? {});
        row.status = to;
      });
    },

    /**
     * Seed / update rows for a freshly submitted plan and attach its task ids.
     * Rows are built complete before they are pushed: a plain object pushed into the
     * draft array is not tracked, so mutating it afterwards would silently not persist.
     */
    async syncPlan(plan, taskIds, ctx) {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(WorkGraph, plan.groupId, null);
        for (const item of plan.items) {
          const id = workItemId(plan.id, item.key);
          const existing = doc.items.find((candidate) => candidate.id === id);
          if (existing) {
            existing.taskId = String(taskIds[item.key] ?? "");
            if (existing.deps.length === 0 && existing.status === "blocked") existing.status = "queued";
            continue;
          }
          const row = { ...blankRow(plan, item), taskId: String(taskIds[item.key] ?? "") };
          doc.items.push(row);
        }
        return null;
      }, ctx);
      return this.list(plan.groupId, ctx);
    },
  };
}
