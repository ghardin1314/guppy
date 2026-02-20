import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const MAX_OUTPUT = 50_000;

const Parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default 30000)" })),
});

export function createBashTool(workspaceDir: string): AgentTool<typeof Parameters> {
  return {
    name: "bash",
    label: "Run Command",
    description: "Execute a shell command in the workspace directory. Returns stdout and stderr.",
    parameters: Parameters,
    async execute(toolCallId, params): Promise<AgentToolResult<undefined>> {
      const timeout = params.timeout ?? 30_000;

      try {
        const proc = Bun.spawn(["bash", "-c", params.command], {
          cwd: workspaceDir,
          stdout: "pipe",
          stderr: "pipe",
        });

        const timer = setTimeout(() => proc.kill(), timeout);
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        clearTimeout(timer);

        const exitCode = await proc.exited;
        let output = "";
        if (stdout) output += stdout;
        if (stderr) output += (output ? "\n" : "") + `stderr: ${stderr}`;
        if (exitCode !== 0) output += `\nExit code: ${exitCode}`;

        if (!output) output = "(no output)";
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT) + `\n... (truncated, ${output.length} total bytes)`;
        }

        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
  };
}
