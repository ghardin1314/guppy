import type { Command } from "commander";
import { existsSync } from "fs";
import { resolve } from "path";

export function registerStart(program: Command) {
  program
    .command("start")
    .option("--port <number>", "port to run on")
    .action(async (opts?: { port?: string }) => {
      await runStart(opts);
    });
}

export async function runStart(opts?: { port?: string }) {
  const cwd = process.cwd();
  const startFile = resolve(cwd, "start.ts");

  if (!existsSync(startFile)) {
    console.error(
      "No start.ts found in current directory.\n" +
      "Make sure you're inside a Guppy project, or run `guppy init` to create one."
    );
    process.exit(1);
  }

  const env = opts?.port
    ? { ...process.env, PORT: opts.port }
    : undefined;

  const proc = Bun.spawn(["bun", "--hot", "start.ts"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  process.on("SIGINT", () => proc.kill());
  process.on("SIGTERM", () => proc.kill());

  const exitCode = await proc.exited;
  process.exit(exitCode);
}
