import type { BotConfig } from "../protocol/types.ts";

/** M1 roster: 1 leader + 4 workers. Each bot is its own agent and runs single-threaded. */
export const BOTS: BotConfig[] = [
  {
    id: "leader",
    name: "领导",
    role: "leader",
    capabilities: ["orchestration"],
    agent: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions:
        "你是群里的编排者。你只做任务分工:把需求拆成 2–4 个可直接派给同事的任务,交给有对应能力的 bot。" +
        "你不规划项目周期、排期、里程碑或预算,也不亲自执行任何任务。只输出结构化结果。",
    },
  },
  {
    id: "finance",
    name: "财务bot",
    role: "worker",
    capabilities: ["finance"],
    agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "你负责财务数据与报表。" },
  },
  {
    id: "data",
    name: "数据bot",
    role: "worker",
    capabilities: ["data"],
    agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "你负责数据处理与可视化。" },
  },
  {
    id: "analysis",
    name: "分析bot",
    role: "worker",
    capabilities: ["analysis"],
    agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "你负责分析与结论。" },
  },
  {
    id: "design",
    name: "设计bot",
    role: "worker",
    capabilities: ["design"],
    agent: { model: { provider: "faux", modelId: "faux-1" }, instructions: "你负责报告模板与排版。" },
  },
];
