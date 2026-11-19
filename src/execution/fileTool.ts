// A real tool: bots write deliverables to their workspace instead of only chatting.
import { defineTool } from "@earendil-works/pi-durable";
import { safeRelativePath } from "./workspace.ts";

export function createWriteFileTool(workspace) {
  return defineTool({
    name: "write_file",
    description:
      "把交付物写成文件(报告、表格、代码、diff 等)。path 是相对路径,如 q3-report.md。可以多次调用写多个文件。",
    replay: "safe",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径,例如 q3-report.md 或 data/chart.csv" },
        content: { type: "string", description: "文件完整内容(UTF-8 文本)" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args, api) {
      const relative = safeRelativePath(args.path);
      const written = await workspace.write(api.conversationId, relative, args.content);
      const output = `已写入 ${relative} (${written.bytes} 字节)`;
      api.output(output);
      // The durable contract is content blocks, not a bare string; a string result would be
      // spread into single characters and lose its pi.tool-result entry.
      return { output: [{ type: "text", text: output }] };
    },
  });
}
