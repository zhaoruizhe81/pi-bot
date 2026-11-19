/** The group channel is a blackboard: passive writes only; it never starts an agent run. */
export function createGroupChannel(harness, groupConversationId) {
  /**
   * Every card and message carries `at`: entries themselves have no timestamp, and the
   * web UI needs one for WeChat-style time separators.
   */
  const append = async (entry, ctx) => {
    const conv = await harness.conversation(groupConversationId, ctx);
    if (!conv) throw new Error("group conversation missing");
    const data = entry.data;
    const stamped =
      data && typeof data === "object" && data.at === undefined
        ? { ...entry, data: { ...data, at: Date.now() } }
        : entry;
    await conv.submit({ type: "write", entry: stamped }, ctx);
  };
  return {
    append,
    /** A person's file / image / voice message: same blackboard, with metadata only. */
    attach: (file, author, ctx, at) =>
      append(
        {
          kind: "chat.file",
          data: { author, file, ...(typeof at === "number" ? { at } : {}) },
        },
        ctx,
      ),
    /** `at` lets an importer (seed data, IM sync) backdate a message. */
    speak: (text, author, ctx, at) =>
      append({ kind: "chat.message", data: { author, text, ...(typeof at === "number" ? { at } : {}) } }, ctx),
  };
}
