import { readFileSync } from "node:fs";
import { join } from "node:path";
import { channelDir } from "./encode";
import type { ThreadMeta } from "./types";

function tryReadFile(path: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

export function formatMemory(dataDir: string, threadMeta: ThreadMeta): string {
  const parts: string[] = [];

  const global = tryReadFile(join(dataDir, "MEMORY.md"));
  if (global) {
    parts.push(`### Global Memory\n${global}`);
  }

  const transport = tryReadFile(
    join(dataDir, threadMeta.adapterName, "MEMORY.md"),
  );
  if (transport) {
    parts.push(`### Transport Memory (${threadMeta.adapterName})\n${transport}`);
  }

  const channel = tryReadFile(
    join(channelDir(dataDir, threadMeta.adapterName, threadMeta.channelKey), "MEMORY.md"),
  );
  if (channel) {
    parts.push(`### Channel Memory\n${channel}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : "(no memory yet)";
}
