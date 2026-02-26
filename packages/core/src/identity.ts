import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_IDENTITY = "You are a chat assistant. Be concise. No emojis.";

export function loadIdentity(dataDir: string): string {
  try {
    const content = readFileSync(join(dataDir, "IDENTITY.md"), "utf-8").trim();
    if (content) return content;
  } catch {}
  return DEFAULT_IDENTITY;
}
