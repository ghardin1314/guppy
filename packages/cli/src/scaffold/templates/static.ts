/**
 * Reads static template files (system-prompt.ts + inspect/*) from disk.
 * Files are stored verbatim as .txt in scaffold/files/ to avoid
 * escaping issues with nested template literals.
 */
import { join } from "node:path";

const FILES_DIR = join(import.meta.dir, "..", "files");

async function read(relativePath: string): Promise<string> {
  return Bun.file(join(FILES_DIR, relativePath)).text();
}

/** Map of relative output path → file content for all static source files. */
export async function getStaticFiles(): Promise<Record<string, string>> {
  const [
    systemPrompt,
    inspectIndex,
    inspectHandler,
    inspectHelpers,
    inspectStyles,
    inspectStats,
    inspectTools,
    inspectMessages,
  ] = await Promise.all([
    read("system-prompt.txt"),
    read("inspect/index.txt"),
    read("inspect/handler.txt"),
    read("inspect/helpers.txt"),
    read("inspect/styles.txt"),
    read("inspect/stats.txt"),
    read("inspect/tools.txt"),
    read("inspect/messages.txt"),
  ]);

  return {
    "src/system-prompt.ts": systemPrompt,
    "src/inspect/index.ts": inspectIndex,
    "src/inspect/handler.ts": inspectHandler,
    "src/inspect/helpers.ts": inspectHelpers,
    "src/inspect/styles.ts": inspectStyles,
    "src/inspect/stats.ts": inspectStats,
    "src/inspect/tools.ts": inspectTools,
    "src/inspect/messages.ts": inspectMessages,
  };
}
