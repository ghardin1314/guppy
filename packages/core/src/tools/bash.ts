import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { Sandbox } from "../sandbox";

const BashParams = Type.Object({
  label: Type.String({ description: "Brief description of what this command does (shown to user)" }),
  command: Type.String({ description: "The bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (default 120)" }),
  ),
});

type BashParams = Static<typeof BashParams>;

export function createBashTool(sandbox: Sandbox): AgentTool<typeof BashParams, undefined> {
  return {
    name: "bash",
    label: "Bash",
    description: "Execute a bash command in the workspace. Returns interleaved stdout+stderr.",
    parameters: BashParams,

    async execute(
      _toolCallId: string,
      params: BashParams,
      signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<undefined>,
    ): Promise<AgentToolResult<undefined>> {
      const timeout = params.timeout ? params.timeout * 1000 : undefined;

      const result = await sandbox.exec(params.command, { timeout, signal });

      if (result.timedOut) {
        throw new Error(
          `Command timed out after ${(timeout ?? 120_000) / 1000}s\n${result.output}`,
        );
      }

      if (signal?.aborted) {
        throw new Error(`Command aborted\n${result.output}`);
      }

      if (result.exitCode !== 0) {
        throw new Error(
          `Command failed (exit ${result.exitCode})\n${result.output}`,
        );
      }

      const content: TextContent[] = [{ type: "text", text: result.output }];
      if (result.truncated && result.fullOutputPath) {
        content.push({
          type: "text",
          text: `Output was truncated. Full output saved to: ${result.fullOutputPath}`,
        });
      }

      return { content, details: undefined };
    },
  };
}
