import { resolve, basename } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { Thread } from "chat";

const UploadParams = Type.Object({
  label: Type.String({ description: "Brief description of what you're uploading and why (shown to user)" }),
  path: Type.String({ description: "File path to upload (absolute or relative to workspace)" }),
  comment: Type.Optional(
    Type.String({ description: "Message to post alongside the file" }),
  ),
});

type UploadParams = Static<typeof UploadParams>;

export function createUploadTool(
  workspacePath: string,
  thread: Thread,
): AgentTool<typeof UploadParams, undefined> {
  return {
    name: "upload",
    label: "Upload File",
    description: "Upload a file to the current thread.",
    parameters: UploadParams,

    async execute(
      _toolCallId: string,
      params: UploadParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<undefined>,
    ): Promise<AgentToolResult<undefined>> {
      const absPath = resolve(workspacePath, params.path);
      const file = Bun.file(absPath);

      if (!(await file.exists())) {
        throw new Error(`File not found: ${params.path}`);
      }

      const data = Buffer.from(await file.arrayBuffer());
      const filename = basename(absPath);
      const mimeType = file.type;

      await thread.post({
        raw: params.comment ?? "",
        files: [{ data, filename, mimeType }],
      });

      const content: TextContent[] = [
        { type: "text", text: `Uploaded ${filename} (${data.byteLength} bytes)` },
      ];
      return { content, details: undefined };
    },
  };
}
