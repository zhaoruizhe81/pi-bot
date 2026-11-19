// Durable artifacts (M2). The id is derived from the work item, so a publish phase that
// re-runs after a crash overwrites its own artifact instead of minting a second one.
import { ArtifactDocToken } from "../state/docs.ts";

export function createArtifactStore(harness) {
  return {
    /** Stable id for a work item's single artifact. */
    idFor: (workItemId) => `a-${workItemId}`,

    async put(artifact, ctx) {
      const id = `a-${artifact.workItemId}`;
      const value = {
        id,
        workItemId: String(artifact.workItemId),
        botId: String(artifact.botId ?? ""),
        kind: String(artifact.kind ?? "text"),
        title: String(artifact.title ?? ""),
        body: String(artifact.body ?? ""),
        ref: String(artifact.ref ?? ""),
        files: Array.isArray(artifact.files) ? artifact.files : [],
        createdAt: Date.now(),
      };
      await harness.commit(async (tx) => {
        const doc = await tx.doc(ArtifactDocToken, id, value);
        Object.assign(doc, value);
        return null;
      }, ctx);
      return id;
    },

    async get(id, ctx) {
      const doc = await harness.snapshot(ArtifactDocToken, String(id), ctx);
      if (!doc) return undefined;
      return {
        id: doc.id,
        workItemId: doc.workItemId,
        botId: doc.botId,
        kind: doc.kind,
        title: doc.title,
        body: doc.body || undefined,
        ref: doc.ref || undefined,
        files: doc.files ?? [],
      };
    },
  };
}
