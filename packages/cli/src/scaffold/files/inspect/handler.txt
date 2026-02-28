import type {
  AgentMessage,
  AssistantMessage,
  Guppy,
  ToolResultMessage,
  UserMessage,
} from "@guppy/core";
import { esc } from "./helpers";
import { renderAssistantMessage, renderUserMessage } from "./messages";
import { computeStats, renderSummary } from "./stats";
import { INSPECT_CSS } from "./styles";

/** Route handler for GET /inspect/:threadId?sig=... */
export function handleInspectRequest(
  req: Request,
  guppy: Guppy,
): Response {
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/inspect/");
  if (pathParts.length < 2 || !pathParts[1]) {
    return new Response("Not Found", { status: 404 });
  }
  const threadId = decodeURIComponent(pathParts[1]);
  const sig = url.searchParams.get("sig");
  if (!sig || !guppy.verifyInspect(threadId, sig)) {
    return new Response("Forbidden", { status: 403 });
  }

  const messages = guppy.store.loadContext(threadId);
  const html = renderThreadHtml(threadId, messages);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function buildResultMap(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const m of messages) {
    if ("role" in m && m.role === "toolResult") {
      const tr = m as ToolResultMessage;
      map.set(tr.toolCallId, tr);
    }
  }
  return map;
}

function renderThreadHtml(threadId: string, messages: AgentMessage[]): string {
  const results = buildResultMap(messages);
  const stats = computeStats(messages);

  const cards: string[] = [];
  for (const m of messages) {
    if (!("role" in m)) continue;
    if (m.role === "toolResult") continue;
    if (m.role === "user") cards.push(renderUserMessage(m as UserMessage));
    else if (m.role === "assistant") cards.push(renderAssistantMessage(m as AssistantMessage, results));
    else cards.push(`<div class="msg"><pre>${esc(JSON.stringify(m, null, 2))}</pre></div>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inspect: ${esc(threadId)}</title>
<style>${INSPECT_CSS}</style>
</head>
<body>
<div class="layout">
  <h1>${esc(threadId)}</h1>
  <div class="thread">${cards.join("\n")}</div>
  ${renderSummary(stats)}
</div>
</body>
</html>`;
}
