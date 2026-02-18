import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveSafePath } from "./shared.ts";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const Parameters = Type.Object({
  path: Type.String({ description: "File path relative to workspace" }),
  content: Type.String({ description: "Content to write" }),
});

export function createWriteTool(workspaceDir: string): AgentTool<typeof Parameters> {
  return {
    name: "write",
    label: "Write File",
    description: "Write content to a file. Creates parent directories if needed.",
    parameters: Parameters,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const absPath = resolveSafePath(workspaceDir, params.path);
      await mkdir(dirname(absPath), { recursive: true });
      await Bun.write(absPath, params.content);

      return {
        content: [{ type: "text", text: `Wrote ${params.content.length} bytes to ${params.path}` }],
        details: undefined,
      };
    },
  };
}
