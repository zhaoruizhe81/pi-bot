// Leader planning: the leader bot itself splits the requirement into 2–4 assigned tasks.
// It is a *task split*, not project planning: no schedules, no milestones, no prose.
import { validatePlan } from "../protocol/plan.ts";
import { readAnswer } from "../publish/answer.ts";

const MAX_ITEMS = 4;

const rosterLines = (bots) =>
  bots
    .filter((bot) => bot.role !== "leader")
    .map((bot) => `- ${bot.id} | ${bot.name} | 能力: ${bot.capabilities.join("/") || "(无)"}`)
    .join("\n");

function composePrompt(requirement, bots) {
  return [
    "把这个需求拆成可以直接派给同事的任务。只做任务分工,不做项目规划(不要排期、里程碑、预算、风险)。",
    "",
    "可派单的同事(按能力):",
    rosterLines(bots),
    "",
    `需求:${requirement}`,
    "",
    `输出要求:只输出一个 JSON 对象,不要解释、不要代码围栏。2–${MAX_ITEMS} 个任务,按执行顺序。`,
    '{"items":[{"key":"W1","subject":"动词开头的任务,≤20字","capability":"上面列出的某个能力","deps":[]}]}',
    "规则:deps 只能引用本计划里排在它前面的 key;没有依赖就写 [];capability 必须是列出的能力之一。",
    "只有确实需要上一步的产出时才写 deps;能同时开工的任务不要串起来。",
    "每个能力只有一个同事,同一能力的两条任务会排队;尽量把任务分给不同能力,除非确实要串行。",
  ].join("\n");
}

/** Tolerant parse: models wrap JSON in prose or fences often enough to matter. */
function parsePlan(text, requirement, groupId, bots) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let raw;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const candidates = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.tasks) ? raw.tasks : [];
  if (candidates.length === 0) return undefined;

  const capabilities = new Set(bots.flatMap((bot) => bot.capabilities));
  const seen = new Set();
  const items = [];
  for (const candidate of candidates.slice(0, MAX_ITEMS)) {
    const key = String(candidate?.key ?? `W${items.length + 1}`).toUpperCase();
    const subject = String(candidate?.subject ?? candidate?.task ?? "").trim();
    const capability = String(candidate?.capability ?? "").trim();
    if (!subject || !capability || seen.has(key) || !capabilities.has(capability)) continue;
    seen.add(key);
    const deps = (Array.isArray(candidate?.deps) ? candidate.deps : [])
      .map((dep) => String(dep).toUpperCase())
      // Forward references would be cycles; drop them instead of failing the plan.
      .filter((dep) => dep !== key && seen.has(dep));
    items.push({ key, subject: subject.slice(0, 40), capability, deps });
  }
  if (items.length === 0) return undefined;

  const plan = { id: `p${Date.now().toString(36)}`, groupId, requirement, items };
  return validatePlan(plan).ok ? plan : undefined;
}

/** Offline / unparsable answer: keep the group working with a sane default split. */
export function fallbackPlan(requirement, groupId) {
  return {
    id: `p${Date.now().toString(36)}`,
    groupId,
    requirement,
    items: [
      { key: "W1", subject: "拉取财务数据", capability: "finance", deps: [] },
      { key: "W2", subject: "数据可视化", capability: "data", deps: ["W1"] },
      { key: "W3", subject: "撰写分析结论", capability: "analysis", deps: ["W2"] },
      { key: "W4", subject: "整理报告模板", capability: "design", deps: [] },
    ],
  };
}

export function createPlanner(deps) {
  return {
    /**
     * Ask the group's leader bot for the split, then validate it. Any failure
     * (busy, timeout, unparsable, invalid graph) falls back to the fixed split so a
     * requirement never stalls the group.
     */
    async plan(groupId, requirement, bots, ctx) {
      const conv = await deps.conversationFor(groupId, ctx);
      if (!conv) return fallbackPlan(requirement, groupId);
      try {
        const submission = await conv.submit(
          {
            type: "input",
            content: composePrompt(requirement, bots),
            requestId: `plan:${groupId}:${Date.now()}`,
            whenBusy: "followUp",
          },
          ctx,
        );
        const settled = await submission.wait(ctx);
        if (settled.status !== "done") return fallbackPlan(requirement, groupId);
        const answer = await readAnswer(conv, ctx);
        return parsePlan(answer, requirement, groupId, bots) ?? fallbackPlan(requirement, groupId);
      } catch {
        return fallbackPlan(requirement, groupId);
      }
    },
  };
}
