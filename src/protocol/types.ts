// Domain types shared across layers. Types only: no runtime logic.
import type { JsonValue } from "@earendil-works/chord/json";

export type BotId = string;
export type GroupId = string;
export type WorkItemId = string;
export type ArtifactId = string;
export type PlanId = string;

export type BotRole = "leader" | "worker";
/** Free-form capability tag, e.g. "finance" / "data" / "analysis" / "design". */
export type Capability = string;

export type BotConfig = {
  id: BotId;
  name: string;
  role: BotRole;
  capabilities: Capability[];
  /** One glyph the UI can composite into a group avatar; empty = first character of name. */
  avatar?: string;
  /** True for bots created in the app, false/absent for the built-in roster. */
  custom?: boolean;
  /** Applied per conversation via conversation.configure(). M1 uses the faux model. */
  agent: {
    model: { provider: string; modelId: string };
    instructions?: string;
    cwd?: string;
  };
};

export type WorkStatus =
  | "blocked"
  | "queued"
  | "running"
  | "delivered"
  | "done"
  | "failed"
  | "cancelled";

export type WorkItem = {
  id: WorkItemId;
  planId: PlanId;
  /** Key within the plan, e.g. "W1". */
  key: string;
  groupId: GroupId;
  subject: string;
  capability: Capability;
  /** Bot that actually runs it; undefined until dispatched. */
  assignee?: BotId;
  deps: WorkItemId[];
  status: WorkStatus;
  blockedReason?: string;
  artifactId?: ArtifactId;
  /** The durable task that runs this work item. */
  taskId?: string;
};

export type Artifact = {
  id: ArtifactId;
  workItemId: WorkItemId;
  botId: BotId;
  kind: "text" | "file" | "diff" | "image";
  title: string;
  /** M1: inline text body. Later: a storage ref instead. */
  body?: string;
  ref?: string;
};

export type PlanItem = {
  /** Local key within the plan, e.g. "W1". */
  key: string;
  subject: string;
  capability: Capability;
  /** Keys of other items in this plan. */
  deps: string[];
  /** Optional pre-assignment; the assigned card is authoritative. */
  preferAssignee?: BotId;
};

/** Leader output: a structured plan, never free text. */
export type Plan = {
  id: PlanId;
  groupId: GroupId;
  requirement: string;
  items: PlanItem[];
};

/** Router decision: avoids the `string` union collapse of `"leader" | BotId`. */
export type Speaker = { kind: "leader" } | { kind: "bot"; id: BotId } | { kind: "none" };

/**
 * Doc payloads must satisfy pi-durable's JsonObject. Concrete document shapes live in
 * `state/docs.ts` next to their definitions.
 */
export type JsonObjectLike = { readonly [key: string]: JsonValue };
