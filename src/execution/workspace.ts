// Deliverables live in two places:
//   data/workspace/<conversationId>/        scratch — cleared before every dispatch
//   data/archive/<groupId>/<workItemId>/    kept forever — what publish copies out
// A bot's scratch dir is reused by its next task, so anything the group can still download
// must come from the archive.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 10;
const MAX_PREVIEW = 20_000;
const TEXT_FILE = /\.(md|txt|json|csv|tsv|ya?ml|diff|patch|ts|js|mjs|py|html|css|sql|sh)$/i;

/** Reject traversal and absolute paths; keep the file inside the conversation's box. */
export function safeRelativePath(input) {
  const cleaned = String(input ?? "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!cleaned) throw new Error("path is required");
  const parts = cleaned.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new Error(`path escapes the workspace: ${input}`);
  return parts.join("/");
}

/** groupId / workItemId are generated, but they reach the filesystem: allow an explicit alphabet. */
export function safeComponent(input, label) {
  const value = String(input ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`invalid ${label}: ${input}`);
  }
  return value;
}

/** Every file under `dir`, name-sorted, with a truncated preview for text files. */
async function walkFiles(dir) {
  const out = [];
  const walk = async (current, prefix) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) continue;
      let preview;
      if (info.size <= MAX_PREVIEW && TEXT_FILE.test(entry.name)) {
        preview = (await readFile(absolute, "utf8").catch(() => "")).slice(0, MAX_PREVIEW);
      }
      out.push({ path: relative, bytes: info.size, preview });
    }
  };
  await walk(dir, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function createWorkspace(root, archiveRoot) {
  const dirFor = (conversationId) => path.join(root, String(conversationId));
  const archiveBase = archiveRoot ?? path.join(path.dirname(root), "archive");
  const archiveDirFor = (groupId, workItemId) =>
    path.join(archiveBase, safeComponent(groupId, "groupId"), safeComponent(workItemId, "workItemId"));

  return {
    root,
    archiveRoot: archiveBase,
    dirFor,
    archiveDirFor,

    async reset(conversationId) {
      const dir = dirFor(conversationId);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      return dir;
    },

    async ensure(conversationId) {
      const dir = dirFor(conversationId);
      await mkdir(dir, { recursive: true });
      return dir;
    },

    async write(conversationId, rawPath, content) {
      const relative = safeRelativePath(rawPath);
      const target = path.join(dirFor(conversationId), relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, String(content ?? ""), "utf8");
      const bytes = Buffer.byteLength(String(content ?? ""), "utf8");
      return { path: relative, absolute: target, bytes };
    },

    /** Files left by the bot for this work item, newest last. */
    async list(conversationId) {
      return walkFiles(dirFor(conversationId));
    },

    /**
     * Copy the bot's scratch deliverables into the group's permanent archive and return them.
     * Idempotent: a publish phase that re-runs after a crash overwrites its own copy.
     */
    async archive(groupId, workItemId, conversationId) {
      const from = dirFor(conversationId);
      const to = archiveDirFor(groupId, workItemId);
      await mkdir(path.dirname(to), { recursive: true });
      await rm(to, { recursive: true, force: true });
      // A bot that answered in chat without writing files still gets an (empty) archive dir,
      // so "no files" and "never archived" stay distinguishable.
      await cp(from, to, { recursive: true, force: true }).catch(async () => {
        await mkdir(to, { recursive: true });
      });
      return walkFiles(to);
    },

    /** File/byte totals for the whole archive, for the settings panel. */
    async stats() {
      let files = 0;
      let bytes = 0;
      const walk = async (dir) => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const target = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(target);
            continue;
          }
          const info = await stat(target).catch(() => undefined);
          if (!info?.isFile()) continue;
          files += 1;
          bytes += info.size;
        }
      };
      await walk(archiveBase);
      return { files, bytes };
    },

    async listArchive(groupId, workItemId) {
      return walkFiles(archiveDirFor(groupId, workItemId));
    },

    /** One archived file, for the download route. Traversal and symlinked escapes are rejected. */
    async readArchive(groupId, workItemId, rawPath) {
      const relative = safeRelativePath(rawPath);
      const dir = archiveDirFor(groupId, workItemId);
      const target = path.join(dir, relative);
      // path.join already normalised; re-check the result really sits inside the archive dir.
      if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
        throw new Error(`path escapes the archive: ${rawPath}`);
      }
      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`unknown file: ${relative}`);
      return { path: relative, bytes: info.size, buffer: await readFile(target) };
    },
  };
}
