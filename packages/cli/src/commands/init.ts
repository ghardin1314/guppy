import type { Command } from "commander";
import { scaffold } from "create-guppy";
import * as clack from "@clack/prompts";
import { resolve, basename, dirname } from "path";
import { $ } from "bun";

interface InitOpts {
  skipInstall?: boolean;
  local?: boolean;
}

export function registerInit(program: Command) {
  program
    .command("init")
    .argument("[dir]", "target directory")
    .option("--skip-install", "skip running bun install")
    .option("--local", "use local workspace @guppy/web (packs tarball)")
    .action(async (dir?: string, opts?: InitOpts) => {
      await runInit(dir, opts);
    });
}

async function packLocalWeb(): Promise<string> {
  const webPkgJson = require.resolve("@guppy/web/package.json");
  const webDir = dirname(webPkgJson);
  const result = await $`cd ${webDir} && bun pm pack`.text();
  const filename = result.split("\n").find((l) => l.endsWith(".tgz"))?.trim();
  if (!filename) throw new Error("Failed to pack @guppy/web — no .tgz in output");
  return resolve(webDir, filename);
}

export async function runInit(dir?: string, opts?: InitOpts) {
  clack.intro("Create a new Guppy project");

  // Resolve target directory
  let targetDir: string;
  if (dir) {
    targetDir = resolve(dir);
  } else {
    const result = await clack.text({
      message: "Where should we create your project?",
      placeholder: "my-guppy-app",
      validate(value) {
        if (!value.trim()) return "Please enter a directory name";
      },
    });
    if (clack.isCancel(result)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }
    targetDir = resolve(result);
  }

  // Check if directory exists and is non-empty
  let entries: string[] = [];
  try {
    const glob = new Bun.Glob("*");
    entries = Array.from(glob.scanSync({ cwd: targetDir, onlyFiles: false }));
  } catch {
    // directory doesn't exist yet — fine
  }
  if (entries.length > 0) {
    const shouldContinue = await clack.confirm({
      message: `Directory "${basename(targetDir)}" is not empty. Continue anyway?`,
    });
    if (clack.isCancel(shouldContinue) || !shouldContinue) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }
  }

  const s = clack.spinner();

  // Pack local @guppy/web if --local
  let packageOverrides: Record<string, string> | undefined;
  if (opts?.local) {
    s.start("Packing local @guppy/web...");
    const tarball = await packLocalWeb();
    s.stop(`Packed ${basename(tarball)}`);
    packageOverrides = { "@guppy/web": `file:${tarball}` };
  }

  s.start("Scaffolding project...");
  await scaffold(targetDir, { packageOverrides });
  s.stop("Project scaffolded");

  if (!opts?.skipInstall) {
    s.start("Installing dependencies...");
    await $`cd ${targetDir} && bun install`.quiet();
    s.stop("Dependencies installed");
  }

  const projectName = basename(targetDir);
  clack.note(
    `cd ${projectName}\nguppy start`,
    "Next steps"
  );

  clack.outro("Happy building!");
}
