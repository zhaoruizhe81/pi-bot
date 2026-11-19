import type { Conversation } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

export type StreamBridge = {
  start(conversation: Conversation, ctx: Context): Promise<void>;
  stop(): Promise<void>;
};

/** TODO(M1): watch(ctx, transcript.resume) -> WS frames; fillGap() to close a stall. */
export function createStreamBridge(_send: (frame: unknown) => void): StreamBridge {
  throw new Error("TODO(M1): createStreamBridge not implemented");
}
