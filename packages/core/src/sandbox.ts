import { sanitizeOutput } from "./sanitize";
import { truncateTail } from "./truncate";

export interface ExecOptions {
  timeout?: number; // ms, default 120_000
  signal?: AbortSignal;
  cwd?: string;
}

export interface ExecResult {
  output: string; // interleaved stdout+stderr, sanitized
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

export interface Sandbox {
  type: "host" | "docker";
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  workspacePath: string;
}

const DEFAULT_TIMEOUT = 120_000;

export function createHostSandbox(workspacePath: string): Sandbox {
  return {
    type: "host",
    workspacePath,

    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
      const cwd = options?.cwd ?? workspacePath;

      const proc = Bun.spawn(["bash", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
      });

      // Set up abort handling
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        proc.kill("SIGKILL");
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });

      // Set up timeout
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeout);

      // Read stdout and stderr concurrently, interleave by arrival
      const chunks: string[] = [];
      const decoder = new TextDecoder();

      async function drain(stream: ReadableStream<Uint8Array>) {
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(decoder.decode(value, { stream: true }));
          }
        } finally {
          reader.releaseLock();
        }
      }

      await Promise.all([
        drain(proc.stdout),
        drain(proc.stderr),
      ]);

      const exitCode = await proc.exited;
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);

      const raw = chunks.join("");
      const sanitized = sanitizeOutput(raw);
      const truncated = truncateTail(sanitized);

      return {
        output: truncated.text,
        exitCode: timedOut || aborted ? 1 : exitCode,
        timedOut,
        truncated: truncated.truncated,
        fullOutputPath: truncated.fullOutputPath,
      };
    },
  };
}
