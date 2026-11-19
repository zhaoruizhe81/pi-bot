import { section } from "@earendil-works/pi-durable";

/** Renders the group's pinned announcement / pins into every bot's prompt. Read-only; never starts a run. */
export function createGroupPinSection(deps) {
  return section("group-context", async (input, ctx) => {
    const groupId = deps.groupIdFor(input.conversationId);
    if (!groupId) return undefined;
    const pin = await deps.pin(groupId, ctx);
    if (!pin) return undefined;
    const pins = (pin.pins ?? []).map((p) => p.text).filter(Boolean);
    if (!pin.announcement && pins.length === 0) return undefined;
    const text = [
      `群公告:${pin.announcement || "(空)"}`,
      pins.length ? `群置顶:\n${pins.join("\n")}` : "",
    ].filter(Boolean).join("\n");
    return text.slice(0, deps.maxChars ?? 8000);
  });
}
