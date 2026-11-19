import type { Plan } from "./types.ts";

/** DFS cycle check over plan item keys. */
export function validatePlan(plan) {
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const state = new Map();
  let cycle = [];
  const visit = (key, path) => {
    const st = state.get(key) ?? 0;
    if (st === 1) {
      const at = path.indexOf(key);
      cycle = [...path.slice(at), key];
      return true;
    }
    if (st === 2) return false;
    state.set(key, 1);
    const item = byKey.get(key);
    if (!item) return false;
    for (const d of item.deps) if (visit(d, [...path, key])) return true;
    state.set(key, 2);
    return false;
  };
  for (const item of plan.items) if (visit(item.key, [])) return { ok: false, cycle };
  return { ok: true };
}

/** Dependencies first. Assumes validatePlan passed. */
export function topoOrder(plan) {
  const byKey = new Map(plan.items.map((i) => [i.key, i]));
  const done = new Set();
  const out = [];
  const visit = (key) => {
    if (done.has(key)) return;
    const item = byKey.get(key);
    if (!item) return;
    for (const d of item.deps) visit(d);
    done.add(key);
    out.push(item);
  };
  for (const item of plan.items) visit(item.key);
  return out;
}

export function resolvePlan(plan, idOf) {
  return plan.items.map((i) => ({ key: i.key, id: idOf(i.key) }));
}
