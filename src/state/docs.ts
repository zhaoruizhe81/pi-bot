// Durable document definitions (M2). Everything the group sees is derived from these
// plus the per-conversation entries; nothing user-visible lives in a process-local Map.
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import type { JsonObjectLike } from "../protocol/types.ts";

/**
 * Session-scoped index of every group in this database. A family cannot be enumerated,
 * so one small singleton lists the keys; every entry is a `musebot.group` member.
 */
export type DirectoryDoc = JsonObjectLike & {
  ids: string[];
};

export type GroupDoc = JsonObjectLike & {
  id: string;
  name: string;
  roster: string[];
  rules: string;
  topic: string;
  createdAt: number;
  /** "dm" for a 1:1 private chat with one bot; absent for a normal group. */
  type?: string;
  /** The blackboard conversation: chat + work cards only, never a run. */
  groupConversationId: string;
  /** Owner of the WorkItem tasks; one per group so tasks stay group-scoped. */
  orchConversationId: string;
  /** botId -> that bot's private conversation in this group. */
  botConversations: Record<string, string>;
};

export type PinJson = JsonObjectLike & {
  id: string;
  text: string;
  by: string;
  at: number;
};

/** Shared context for every bot in the group. Read-only: changing it starts no run. */
export type PinDoc = JsonObjectLike & {
  announcement: string;
  pins: PinJson[];
};

/** JSON form of one WorkItem; absent fields are "" so a draft never needs undefined. */
export type WorkItemJson = JsonObjectLike & {
  id: string;
  planId: string;
  key: string;
  groupId: string;
  subject: string;
  capability: string;
  assignee: string;
  deps: string[];
  status: string;
  blockedReason: string;
  artifactId: string;
  taskId: string;
};

export type WorkGraphDoc = JsonObjectLike & {
  items: WorkItemJson[];
};

export type ArtifactDoc = JsonObjectLike & {
  id: string;
  workItemId: string;
  botId: string;
  kind: string;
  title: string;
  body: string;
  ref: string;
  /** Files the bot wrote through `write_file`, in path order. */
  files: JsonValue[];
  createdAt: number;
};

/** Every doc here is small and rewritten often, so each change is stored as a full base. */
const alwaysBase = () => true;

export const Directory = defineDoc<DirectoryDoc>({
  kind: "musebot.directory",
  version: 1,
  scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: alwaysBase,
});

/** Per-group bridge config for an external IM (WeCom bot, 公众号 relay, custom script). */
export type ImBridgeDoc = JsonObjectLike & {
  groupId: string;
  token: string;
  enabled: boolean;
  callbackUrl: string;
  updatedAt: number;
};

export const ImBridge = defineDocFamily<ImBridgeDoc, null>({
  kind: "musebot.im-bridge",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ groupId: "", token: "", enabled: true, callbackUrl: "", updatedAt: 0 }),
  checkpointWhen: alwaysBase,
});

/** One row of process-wide configuration the settings panel can edit. */
export type SettingsDoc = JsonObjectLike & {
  api: string;
  baseUrl: string;
  modelId: string;
  /** Kept server-side only; the API answers with a mask. */
  apiKey: string;
  /** Bind address for the HTTP server: 127.0.0.1 (this machine) or 0.0.0.0 (LAN/tailnet). */
  host: string;
  updatedAt: number;
};

export const Settings = defineDoc<SettingsDoc>({
  kind: "musebot.settings",
  version: 1,
  scope: "session",
  initial: () => ({ api: "", baseUrl: "", modelId: "", apiKey: "", host: "", updatedAt: 0 }),
  checkpointWhen: alwaysBase,
});

/** The human on this side of the glass: nickname, signature, avatar (data URL). */
export type UserProfileDoc = JsonObjectLike & {
  name: string;
  signature: string;
  avatar: string;
  updatedAt: number;
};

export const UserProfile = defineDoc<UserProfileDoc>({
  kind: "musebot.user-profile",
  version: 1,
  scope: "session",
  initial: () => ({ name: "我", signature: "", avatar: "", updatedAt: 0 }),
  checkpointWhen: alwaysBase,
});

/**
 * A bot the user created. Built-ins are code; these are data, so they are listed in a
 * small directory and read back on startup exactly like groups.
 */
export type CustomBotDoc = JsonObjectLike & {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  instructions: string;
  /** One glyph (emoji/letter); empty means "use the first character of the name". */
  avatar: string;
  createdAt: number;
  updatedAt: number;
};

export type BotDirectoryDoc = JsonObjectLike & {
  ids: string[];
};

export const BotDirectory = defineDoc<BotDirectoryDoc>({
  kind: "musebot.bot-directory",
  version: 1,
  scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: alwaysBase,
});

export const CustomBot = defineDocFamily<CustomBotDoc, CustomBotDoc>({
  kind: "musebot.custom-bot",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: alwaysBase,
});

/** Global display identity for a bot: name and avatar override the code/custom config. */
export type BotIdentityBookDoc = JsonObjectLike & {
  bots: Record<string, { name: string; avatar: string; updatedAt: number }>;
};

export const BotIdentityBook = defineDoc<BotIdentityBookDoc>({
  kind: "musebot.bot-identity",
  version: 1,
  scope: "session",
  initial: () => ({ bots: {} }),
  checkpointWhen: alwaysBase,
});

/**
 * Which installed skills each bot may use. `enabled` is a whitelist of skill names and
 * is only written once a bot is toggled: no row means "every discovered skill is on".
 */
export type BotSkillsBookDoc = JsonObjectLike & {
  bots: Record<string, { enabled: string[]; updatedAt: number }>;
};

export const BotSkillsBook = defineDoc<BotSkillsBookDoc>({
  kind: "musebot.bot-skills",
  version: 1,
  scope: "session",
  initial: () => ({ bots: {} }),
  checkpointWhen: alwaysBase,
});

/** Per-group overrides for one bot: its prompt and (optionally) its model. */
export type BotProfileDoc = JsonObjectLike & {
  groupId: string;
  botId: string;
  instructions: string;
  model: string;
  updatedAt: number;
};

export const BotProfile = defineDocFamily<BotProfileDoc, null>({
  kind: "musebot.bot-profile",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ groupId: "", botId: "", instructions: "", model: "", updatedAt: 0 }),
  checkpointWhen: alwaysBase,
});

/**
 * One durable memory item: a short, human-readable fact/preference the bot should keep
 * across tasks. `score` is a reinforcement counter (a re-mentioned item grows it) and
 * also the eviction key once the per-bot cap is hit.
 */
export type MemoryItemJson = JsonObjectLike & {
  id: string;
  text: string;
  /** preference / instruction / conclusion / fact */
  kind: string;
  /** where it came from: requirement / delivery / manual */
  source: string;
  at: number;
  score: number;
};

/** Long-term memory for one bot inside one group, keyed `${groupId}::${botId}`. */
export type MemoryDoc = JsonObjectLike & {
  groupId: string;
  botId: string;
  enabled: boolean;
  items: MemoryItemJson[];
};

export const Memory = defineDocFamily<MemoryDoc, null>({
  kind: "musebot.memory",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ groupId: "", botId: "", enabled: true, items: [] }),
  checkpointWhen: alwaysBase,
});

export const Group = defineDocFamily<GroupDoc, { id: string; name: string; roster: string[]; rules: string; topic: string; createdAt: number }>({
  kind: "musebot.group",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({
    id: seed.id,
    name: seed.name,
    roster: [...seed.roster],
    rules: seed.rules,
    topic: seed.topic,
    createdAt: seed.createdAt,
    groupConversationId: "",
    orchConversationId: "",
    botConversations: {},
  }),
  checkpointWhen: alwaysBase,
});

export const Pin = defineDocFamily<PinDoc, null>({
  kind: "musebot.group-pin",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ announcement: "", pins: [] }),
  checkpointWhen: alwaysBase,
});

export const WorkGraph = defineDocFamily<WorkGraphDoc, null>({
  kind: "musebot.work-graph",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ items: [] }),
  checkpointWhen: alwaysBase,
});

export const ArtifactDocToken = defineDocFamily<ArtifactDoc, ArtifactDoc>({
  kind: "musebot.artifact",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => seed,
  checkpointWhen: alwaysBase,
});
