import type { AssistantMessage, TextContent, ToolResultMessage, UserMessage } from "@guppy/core";
import { esc, fmtTime } from "./helpers";
import { renderToolCall } from "./tools";

export function renderUserMessage(m: UserMessage): string {
  const text = typeof m.content === "string"
    ? m.content
    : m.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("");
  const time = fmtTime(m.timestamp);
  return `<div class="msg msg-user">
  <div class="msg-header"><span class="role">user</span>${time ? `<span class="ts">${time}</span>` : ""}</div>
  <pre>${esc(text)}</pre>
</div>`;
}

export function renderAssistantMessage(m: AssistantMessage, results: Map<string, ToolResultMessage>): string {
  const parts: string[] = [];

  for (const c of m.content) {
    if (c.type === "text" && c.text) {
      parts.push(`<pre>${esc(c.text)}</pre>`);
    } else if (c.type === "thinking" && c.thinking) {
      parts.push(`<details class="thinking"><summary>thinking</summary><pre>${esc(c.thinking)}</pre></details>`);
    } else if (c.type === "toolCall") {
      parts.push(renderToolCall(c, results.get(c.id)));
    }
  }

  const time = fmtTime(m.timestamp);
  const model = m.model ? `<span class="meta-item">${esc(m.model)}</span>` : "";
  const tokens = m.usage?.totalTokens ? `<span class="meta-item">${m.usage.totalTokens.toLocaleString()} tok</span>` : "";
  const cost = m.usage?.cost?.total != null ? `<span class="meta-item">$${m.usage.cost.total.toFixed(4)}</span>` : "";
  const stop = m.stopReason && m.stopReason !== "stop" && m.stopReason !== "toolUse"
    ? `<span class="meta-item meta-warn">${esc(m.stopReason)}</span>` : "";
  const errorInfo = m.errorMessage ? `<div class="msg-error">${esc(m.errorMessage)}</div>` : "";

  return `<div class="msg msg-assistant">
  <div class="msg-header"><span class="role">assistant</span>${time ? `<span class="ts">${time}</span>` : ""}</div>
  ${parts.join("\n  ")}
  ${errorInfo}
  <div class="meta">${model}${tokens}${cost}${stop}</div>
</div>`;
}
