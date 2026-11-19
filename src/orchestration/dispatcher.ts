import type { AnyTask, Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { Scheduler } from "./scheduler.ts";

export type DispatcherDeps = {
  harness: Harness;
  scheduler: Scheduler;
  /** The one-shot DispatchTask definition. */
  dispatchTask: AnyTask;
  /** Ownerless orchestration conversation. */
  orchConversationId: string;
};

/**
 * One-shot durable dispatcher (no signals): a DispatchDoc{taskId} dedupes it.
 * It runs dispatchReady, sleeps 2s while work is queued but no bot is idle, and ends when drained.
 */
export type Dispatcher = {
  ensureRunning(ctx: Context): Promise<void>;
};

/** TODO(M1): dedupe via DispatchDoc; background: true; sleepUntil poll. */
export function createDispatcher(_deps: DispatcherDeps): Dispatcher {
  throw new Error("TODO(M1): createDispatcher not implemented");
}
