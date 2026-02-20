import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveSafePath } from "./shared.ts";

const Parameters = Type.Object({
  path: Type.String({ description: "File path relative to workspace" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-based)" })),
  limit: Type.Optional(Type.Number({ description: "Number of lines to read" })),
});

export function createReadTool(workspaceDir: string): AgentTool<typeof Parameters> {
  return {
    name: "read",
    label: "Read File",
    description: "Read file contents. Returns the file content as text with line numbers.",
    parameters: Parameters,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const absPath = resolveSafePath(workspaceDir, params.path);
      const file = Bun.file(absPath);

      if (!(await file.exists())) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${params.path}` }],
          details: undefined,
        };
      }

      const text = await file.text();
      const lines = text.split("\n");

      const offset = (params.offset ?? 1) - 1;
      const limit = params.limit ?? lines.length;
      const sliced = lines.slice(offset, offset + limit);

      const numbered = sliced
        .map((line, i) => `${String(offset + i + 1).padStart(6)} │ ${line}`)
        .join("\n");

      return {
        content: [{ type: "text", text: numbered }],
        details: undefined,
      };
    },
  };
}
