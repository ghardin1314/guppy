import { resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import { truncateHead } from "../truncate";

const ReadParams = Type.Object({
  path: Type.String({ description: "File path (absolute or relative to workspace)" }),
  offset: Type.Optional(
    Type.Number({ description: "Start line (1-indexed)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max lines to read" }),
  ),
});

type ReadParams = Static<typeof ReadParams>;

export function createReadTool(workspacePath: string): AgentTool<typeof ReadParams, undefined> {
  return {
    name: "read",
    label: "Read File",
    description: "Read a file's contents with line numbers. Images are returned as base64.",
    parameters: ReadParams,

    async execute(
      _toolCallId: string,
      params: ReadParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<undefined>,
    ): Promise<AgentToolResult<undefined>> {
      const absPath = resolve(workspacePath, params.path);
      const file = Bun.file(absPath);

      if (!(await file.exists())) {
        throw new Error(`File not found: ${params.path}`);
      }

      const mime = file.type;

      // Image files: return as base64 ImageContent
      if (mime.startsWith("image/")) {
        const buf = await file.arrayBuffer();
        const data = Buffer.from(buf).toString("base64");
        const content: ImageContent[] = [
          { type: "image", data, mimeType: mime },
        ];
        return { content, details: undefined };
      }

      // Text files
      const raw = await file.text();
      const allLines = raw.split("\n");
      const totalLines = allLines.length;

      const offset = params.offset ? Math.max(1, params.offset) : 1;
      const limit = params.limit ?? totalLines;
      const startIdx = offset - 1;
      const selected = allLines.slice(startIdx, startIdx + limit);

      // Prepend line numbers
      const numbered = selected.map(
        (line, i) => `${String(startIdx + i + 1).padStart(6, " ")}\t${line}`,
      );
      const joined = numbered.join("\n");

      // Truncate if still too large
      const truncated = truncateHead(joined);

      let text = truncated.text;
      if (startIdx + limit < totalLines && !truncated.truncated) {
        text += `\n[Showing lines ${offset}-${offset + selected.length - 1} of ${totalLines}]`;
      }

      const content: TextContent[] = [{ type: "text", text }];
      return { content, details: undefined };
    },
  };
}
