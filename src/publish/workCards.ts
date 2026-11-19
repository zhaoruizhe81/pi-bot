/** Group-visible cards. Only chat + work cards enter the group; never transcripts. */

/**
 * Every card names the task it is about and stamps itself: entries carry no timestamp,
 * and the UI needs both the task title and the time for WeChat-style separators.
 */
const about = (wi) => ({
  workId: wi.id,
  ...(wi.key ? { key: wi.key } : {}),
  ...(wi.subject ? { subject: wi.subject } : {}),
  at: Date.now(),
});

export function planCard(plan, by, workIds = {}) {
  // `workIds` maps plan keys to their WorkItem ids, so the UI can cancel a single row.
  return {
    kind: "work.event",
    data: { ev: "plan", planId: plan.id, groupId: plan.groupId, by, items: plan.items, workIds, at: Date.now() },
  };
}

export function assignedCard(wi) {
  return { kind: "work.event", data: { ev: "assigned", ...about(wi), botId: wi.assignee ?? "?", deps: wi.deps ?? [] } };
}

export function startedCard(wi) {
  return { kind: "work.event", data: { ev: "started", ...about(wi), botId: wi.assignee ?? "?" } };
}

export function blockedCard(wi, reason) {
  return { kind: "work.event", data: { ev: "blocked", ...about(wi), botId: wi.assignee, reason } };
}

export function deliveredCard(wi, artifact) {
  return { kind: "work.event", data: { ev: "delivered", ...about(wi), botId: wi.assignee ?? artifact.botId, artifact } };
}

export function doneCard(wi) {
  return { kind: "work.event", data: { ev: "done", ...about(wi), botId: wi.assignee ?? "?" } };
}

export function failedCard(wi, error) {
  return { kind: "work.event", data: { ev: "failed", ...about(wi), botId: wi.assignee, error } };
}

export function cancelledCard(wi, reason) {
  return { kind: "work.event", data: { ev: "cancelled", ...about(wi), reason } };
}

export function cardFor(workItem) {
  switch (workItem.status) {
    case "blocked": return blockedCard(workItem, workItem.blockedReason ?? "blocked");
    case "running": return startedCard(workItem);
    case "done": return doneCard(workItem);
    case "failed": return failedCard(workItem, workItem.blockedReason ?? "failed");
    default: return blockedCard(workItem, workItem.status);
  }
}
