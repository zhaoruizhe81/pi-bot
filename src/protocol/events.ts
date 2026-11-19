// Entries that may appear in the group channel. Only chat + work cards; never raw transcripts.
// `ev` lives inside `data` so the whole value is a valid EntryDraft ({ kind, data }).
import type { Artifact, BotId, GroupId, PlanItem, WorkItemId } from "./types.ts";

export type Author = { type: "human" | "bot"; id: string; name: string };

export type ChatMessage = {
  kind: "chat.message";
  data: { author: Author; text: string };
};

export type WorkEvent = {
  kind: "work.event";
  data:
    | { ev: "plan"; planId: string; groupId: GroupId; by: BotId; items: PlanItem[] }
    | { ev: "assigned"; workId: WorkItemId; botId: BotId; deps: WorkItemId[] }
    | { ev: "started"; workId: WorkItemId; botId: BotId }
    | { ev: "blocked"; workId: WorkItemId; reason: string }
    | { ev: "delivered"; workId: WorkItemId; botId: BotId; artifact: Artifact }
    | { ev: "done"; workId: WorkItemId; botId: BotId }
    | { ev: "failed"; workId: WorkItemId; botId?: BotId; error: string }
    | { ev: "cancelled"; workId: WorkItemId; botId?: BotId; reason?: string }
    // DM direct chat's only work.event: a lightweight gray "working" row while the reply
    // generates. `ev` is the display text itself (the webui renders unknown ev verbatim);
    // a DM never shows plan / delivery cards.
    | { ev: "正在处理…"; by: BotId };
};

export type ChannelEntry = ChatMessage | WorkEvent;
