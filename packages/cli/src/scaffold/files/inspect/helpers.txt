import type { TextContent, ToolResultMessage } from "@guppy/core";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function truncate(text: string, max = 5000): string {
  return text.length > max ? text.slice(0, max) + "\n\u2026 (truncated)" : text;
}

export function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? "\u2026/" + parts.slice(-2).join("/") : p;
}

export function extractText(msg: ToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
