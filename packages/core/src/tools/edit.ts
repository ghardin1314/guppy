import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveSafePath } from "./shared.ts";

const Parameters = Type.Object({
  path: Type.String({ description: "File path relative to workspace" }),
  old_string: Type.String({ description: "Exact string to find and replace (must be unique in file)" }),
  new_string: Type.String({ description: "Replacement string" }),
});

export function createEditTool(workspaceDir: string): AgentTool<typeof Parameters> {
  return {
    name: "edit",
    label: "Edit File",
    description:
      "Replace an exact string in a file. The old_string must appear exactly once in the file. Use this for surgical edits.",
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
      const count = text.split(params.old_string).length - 1;

      if (count === 0) {
        return {
          content: [{ type: "text", text: `Error: old_string not found in ${params.path}` }],
          details: undefined,
        };
      }
      if (count > 1) {
        return {
          content: [
            {
              type: "text",
              text: `Error: old_string found ${count} times in ${params.path}. Must be unique.`,
            },
          ],
          details: undefined,
        };
      }

      const updated = text.replace(params.old_string, params.new_string);
      await Bun.write(absPath, updated);

      return {
        content: [
          {
            type: "text",
            text: `Edited ${params.path}:\n- ${params.old_string}\n+ ${params.new_string}`,
          },
        ],
        details: undefined,
      };
    },
  };
}
