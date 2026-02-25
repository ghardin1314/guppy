import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";

const WriteParams = Type.Object({
  path: Type.String({ description: "File path (absolute or relative to workspace)" }),
  content: Type.String({ description: "File content to write" }),
});

type WriteParams = Static<typeof WriteParams>;

export function createWriteTool(workspacePath: string): AgentTool<typeof WriteParams, undefined> {
  return {
    name: "write",
    label: "Write File",
    description: "Write content to a file. Creates parent directories if needed.",
    parameters: WriteParams,

    async execute(
      _toolCallId: string,
      params: WriteParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<undefined>,
    ): Promise<AgentToolResult<undefined>> {
      const absPath = resolve(workspacePath, params.path);
      await mkdir(dirname(absPath), { recursive: true });
      const bytes = await Bun.write(absPath, params.content);

      const content: TextContent[] = [
        { type: "text", text: `Wrote ${bytes} bytes to ${params.path}` },
      ];
      return { content, details: undefined };
    },
  };
}
