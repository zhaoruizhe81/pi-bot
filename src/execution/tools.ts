// Real read + bash tools: bots inspect their workspace files and run commands in it.
// Replay policy follows pi-durable's tool contract ("safe" reruns after a restart, "unsafe"
// never reruns because it may have partially run): read is "safe", bash is "unsafe".
import { defineTool } from "@earendil-works/pi-durable";
import { exec } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { safeRelativePath } from "./workspace.ts";

const READ_MAX_CHARS = 20_000;
const READ_DEFAULT_LINES = 2_000;
const BASH_MAX_CHARS = 10_000;
const BASH_DEFAULT_TIMEOUT_MS = 30_000;
const BASH_MAX_TIMEOUT_MS = 60_000;

/** NUL bytes almost never appear in text; the first chunk carrying one marks a binary file. */
function looksBinary(buffer) {
  return buffer.subarray(0, 8_000).includes(0);
}

/** Clamp the model's timeout request into (0, 60000] ms, defaulting when absent or nonsense. */
function bashTimeoutMs(value) {
  const asked = Number(value);
  if (!Number.isFinite(asked) || asked <= 0) return BASH_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.round(asked), BASH_MAX_TIMEOUT_MS);
}

export function createReadTool(workspace) {
  return defineTool({
    name: "read",
    description:
      "读取 workspace 内文本文件。path 是相对路径(如 q3-report.md);offset 是起始行号(从 1 起),lines 是行数(默认 2000)。" +
      "返回被截断或只显示部分行时会注明,可用 offset 翻页继续。不支持二进制文件。",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径,例如 q3-report.md 或 data/chart.csv" },
        offset: { type: "number", description: "起始行号(从 1 起),默认从头读" },
        lines: { type: "number", description: "本次读取的行数,默认 2000" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, api) {
      const relative = safeRelativePath(args.path);
      const dir = workspace.dirFor(api.conversationId);
      const target = path.join(dir, relative);
      // path.join already normalised; re-check the result really sits inside the workspace dir.
      if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) {
        throw new Error(`path escapes the workspace: ${args.path}`);
      }
      const info = await stat(target).catch(() => undefined);
      if (!info) throw new Error(`文件不存在: ${relative}`);
      if (info.isDirectory()) throw new Error(`是目录,不是文件: ${relative}`);
      const buffer = await readFile(target);
      if (looksBinary(buffer)) throw new Error(`暂不支持二进制: ${relative}`);

      const allLines = buffer.toString("utf8").split("\n");
      const totalLines = allLines.length;
      const startLine = Math.max(1, Math.floor(Number(args.offset) || 1));
      if (startLine > totalLines) {
        throw new Error(`offset ${args.offset} 超出文件末尾(共 ${totalLines} 行): ${relative}`);
      }
      const wanted = Number(args.lines);
      const lineCount = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : READ_DEFAULT_LINES;
      const shown = allLines.slice(startLine - 1, startLine - 1 + lineCount);
      const selected = shown.join("\n");

      let text = selected;
      const notes = [];
      const endLine = startLine - 1 + shown.length;
      if (endLine < totalLines) {
        notes.push(`[共 ${totalLines} 行,显示第 ${startLine}-${endLine} 行,继续读用 offset=${endLine + 1}]`);
      }
      if (text.length > READ_MAX_CHARS) {
        text = text.slice(0, READ_MAX_CHARS);
        notes.push(`[已截断:本次返回上限 ${READ_MAX_CHARS} 字符,用更大的 offset 继续读]`);
      }
      if (!text) text = `[文件 ${relative} 从第 ${startLine} 行起没有内容]`;
      const output = notes.length ? `${text}\n${notes.join("\n")}` : text;
      api.output(output);
      // The durable contract is content blocks, not a bare string; a string result loses its entry.
      return { output: [{ type: "text", text: output }] };
    },
  });
}

export function createBashTool(workspace) {
  return defineTool({
    name: "bash",
    description:
      "在当前会话的 workspace 目录里执行 shell 命令,stdout 和 stderr 合并返回(截 10000 字符)。" +
      "timeoutMs 上限 60000、默认 30000;超时的命令会被终止并在结果里说明。",
    // A command may have already changed the world when it is interrupted: never rerun it.
    replay: "unsafe",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令,如 ls -la 或 cat notes.md" },
        timeoutMs: { type: "number", description: "超时毫秒数,上限 60000,默认 30000;超时会被终止" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args, api) {
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("command is required");
      const timeoutMs = bashTimeoutMs(args.timeoutMs);
      // The bot's scratch dir must exist before the first command touches it.
      const cwd = await workspace.ensure(api.conversationId);

      const settled = await new Promise((resolve) => {
        exec(command, { cwd, timeout: timeoutMs, killSignal: "SIGTERM", maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) =>
          resolve({ error, stdout: String(stdout), stderr: String(stderr) }),
        );
      });
      // The `timeout` kill carries killed + SIGTERM; a maxBuffer truncation has neither, so it never reads as a timeout.
      const timedOut = settled.error?.killed === true && settled.error.signal === "SIGTERM";
      const combined = `${settled.stdout}${settled.stderr}`;
      let text = combined.length > BASH_MAX_CHARS ? combined.slice(0, BASH_MAX_CHARS) : combined;
      const notes = [];
      if (!text) text = "(无输出)";
      if (combined.length > BASH_MAX_CHARS) notes.push(`[已截断:输出超过 ${BASH_MAX_CHARS} 字符]`);
      if (timedOut) notes.push(`[命令超过 ${timeoutMs}ms 已被终止(killed),下方输出可能不完整]`);
      else if (settled.error && typeof settled.error.code === "number" && settled.error.code !== 0) {
        notes.push(`[exit code ${settled.error.code}]`);
      }
      const output = notes.length ? `$ ${command}\n${text}\n${notes.join("\n")}` : `$ ${command}\n${text}`;
      api.output(output);
      // The durable contract is content blocks, not a bare string; a string result loses its entry.
      return { output: [{ type: "text", text: output }] };
    },
  });
}
