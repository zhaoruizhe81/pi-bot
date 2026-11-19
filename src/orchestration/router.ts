// Who should act on a message. Rules only — the Jev classifier is still a future step.
// The point here is that people just talk: a request is recognised, a chat line is not.

const TASK_VERB = "(?:做|写|出|整理|生成|汇总|核算|盘点|起草|拟|拉取|搭建|设计)";
const TASK_NOUN = "(?:报告|财报|周报|日报|月报|方案|摘要|模板|图表|可视化|清单|计划|分析|结论|脚本|代码|函数|页面|ppt|文档|表格)";

/** "帮我出一份财报" / "整理一版周报" / "出一版 Q3 财报" — but not "收到,我先拉一版图表". */
export function isTaskRequest(text) {
  const input = String(text ?? "").trim();
  if (!input) return false;
  if (/(帮我|帮忙|麻烦|请).{0,20}(做|写|出|整理|生成|汇总|核算|盘点|起草|拟)/.test(input)) return true;
  // verb ... noun with little in between, and the verb must start the sentence or follow 再/顺便/先.
  return new RegExp(`(?:^|[，,。;；\\s])(?:再|顺便|先|然后)?.{0,4}${TASK_VERB}.{0,12}${TASK_NOUN}`, "i").test(input);
}

export function createRouter() {
  return {
    /**
     * `mentions` are bot ids the message addresses. A leader mention always means
     * "give this to the planner"; a worker mention is just a chat line for now.
     */
    async route(input, _ctx) {
      const text = String(input.text ?? "");
      const mentions = Array.isArray(input.mentions) ? input.mentions : [];
      if (mentions.includes("leader")) {
        return { respond: true, speaker: { kind: "leader" }, reason: "leader-mention" };
      }
      if (isTaskRequest(text)) {
        return { respond: true, speaker: { kind: "leader" }, reason: "task-request" };
      }
      if (mentions.length > 0) {
        return { respond: true, speaker: { kind: "bot", id: mentions[0] }, reason: "mention" };
      }
      return { respond: false, speaker: { kind: "none" }, reason: "chatter" };
    },
  };
}
