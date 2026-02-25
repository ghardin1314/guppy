import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024; // 50KB

export interface TruncateResult {
  text: string;
  truncated: boolean;
  totalLines: number;
  fullOutputPath?: string;
}

interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
}

function writeTempFile(content: string): string {
  const dir = join(tmpdir(), "guppy-output");
  mkdirSync(dir, { recursive: true });
  const id = randomBytes(6).toString("hex");
  const path = join(dir, `guppy-output-${id}.txt`);
  writeFileSync(path, content);
  return path;
}

/**
 * Keep the **last** N lines — used for bash output where errors/results are at the end.
 */
export function truncateTail(
  text: string,
  opts?: TruncateOptions,
): TruncateResult {
  const maxLines = opts?.maxLines ?? MAX_LINES;
  const maxBytes = opts?.maxBytes ?? MAX_BYTES;
  const lines = text.split("\n");
  const totalLines = lines.length;

  let needsTruncation = totalLines > maxLines;

  // Byte check: even if line count is within limit, text might exceed byte budget
  if (!needsTruncation && Buffer.byteLength(text, "utf-8") > maxBytes) {
    needsTruncation = true;
  }

  if (!needsTruncation) {
    return { text, truncated: false, totalLines };
  }

  const fullOutputPath = writeTempFile(text);

  // Take last maxLines lines
  let kept = lines.slice(-maxLines);

  // If still over byte limit, trim further from the front
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf-8") > maxBytes) {
    kept = kept.slice(Math.ceil(kept.length * 0.1));
  }

  const startLine = totalLines - kept.length + 1;
  const endLine = totalLines;
  const notice = `[Showing lines ${startLine}-${endLine} of ${totalLines}. Full output: ${fullOutputPath}]`;
  return {
    text: notice + "\n" + kept.join("\n"),
    truncated: true,
    totalLines,
    fullOutputPath,
  };
}

/**
 * Keep the **first** N lines — used for file reads where the start matters.
 */
export function truncateHead(
  text: string,
  opts?: TruncateOptions,
): TruncateResult {
  const maxLines = opts?.maxLines ?? MAX_LINES;
  const maxBytes = opts?.maxBytes ?? MAX_BYTES;
  const lines = text.split("\n");
  const totalLines = lines.length;

  let needsTruncation = totalLines > maxLines;

  if (!needsTruncation && Buffer.byteLength(text, "utf-8") > maxBytes) {
    needsTruncation = true;
  }

  if (!needsTruncation) {
    return { text, truncated: false, totalLines };
  }

  const fullOutputPath = writeTempFile(text);

  // Take first maxLines lines
  let kept = lines.slice(0, maxLines);

  // If still over byte limit, trim further from the end
  while (kept.length > 1 && Buffer.byteLength(kept.join("\n"), "utf-8") > maxBytes) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
  }

  const notice = `[Showing lines 1-${kept.length} of ${totalLines}. Full output: ${fullOutputPath}]`;
  return {
    text: kept.join("\n") + "\n" + notice,
    truncated: true,
    totalLines,
    fullOutputPath,
  };
}
