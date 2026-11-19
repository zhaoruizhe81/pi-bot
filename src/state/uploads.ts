// Files a person sends into a group (the composer's 文件 / 图片 / 语音 buttons).
// Stored on disk, referenced from a `chat.file` entry by id, so history stays renderable
// after a restart. Names are sanitised; ids are generated here, never taken from the client.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MAX_BYTES = 12 * 1024 * 1024;

/** Keep the display name readable but never let it touch the path. */
export function uploadName(input) {
  const base = String(input ?? "").split("/").pop().split("\\").pop();
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  if (!cleaned) return "file";
  return cleaned.slice(0, 120);
}

export function createUploadStore(root) {
  const dirFor = (groupId, id) => path.join(root, groupId, id);

  return {
    root,
    maxBytes: MAX_BYTES,

    async put(groupId, input) {
      const name = uploadName(input?.name);
      const mime = String(input?.mime ?? "application/octet-stream").slice(0, 120);
      const base64 = String(input?.data ?? "");
      if (!base64) throw new Error("file data is required");
      const buffer = Buffer.from(base64, "base64");
      if (!buffer.length) throw new Error("file is empty");
      if (buffer.length > MAX_BYTES) throw new Error(`file is too large (max ${Math.round(MAX_BYTES / 1024 / 1024)}MB)`);
      const id = randomUUID();
      const dir = path.join(root, groupId);
      await mkdir(dir, { recursive: true });
      await writeFile(dirFor(groupId, id), buffer);
      return { id, name, mime, bytes: buffer.length };
    },

    async get(groupId, id) {
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error(`unknown file: ${id}`);
      const target = dirFor(groupId, id);
      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`unknown file: ${id}`);
      return { buffer: await readFile(target), bytes: info.size };
    },
  };
}
