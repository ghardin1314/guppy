import type {
  AgentMessage,
  AssistantMessage,
  Guppy,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@guppy/core";

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

// -- Helpers --

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function truncate(text: string, max = 5000): string {
  return text.length > max ? text.slice(0, max) + "\n\u2026 (truncated)" : text;
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 2 ? "\u2026/" + parts.slice(-2).join("/") : p;
}

function extractText(msg: ToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// -- Summary stats --

interface ThreadStats {
  turns: number;
  toolCalls: number;
  toolsByName: Map<string, number>;
  models: Set<string>;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
  firstTs: number;
  lastTs: number;
}

function computeStats(messages: AgentMessage[]): ThreadStats {
  const stats: ThreadStats = {
    turns: 0, toolCalls: 0, toolsByName: new Map(), models: new Set(),
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0,
    firstTs: Infinity, lastTs: 0,
  };

  for (const m of messages) {
    if (!("role" in m)) continue;
    if (m.timestamp) {
      stats.firstTs = Math.min(stats.firstTs, m.timestamp);
      stats.lastTs = Math.max(stats.lastTs, m.timestamp);
    }

    if (m.role === "assistant") {
      const am = m as AssistantMessage;
      stats.turns++;
      if (am.model) stats.models.add(am.model);
      if (am.usage) {
        stats.input += am.usage.input ?? 0;
        stats.output += am.usage.output ?? 0;
        stats.cacheRead += am.usage.cacheRead ?? 0;
        stats.cacheWrite += am.usage.cacheWrite ?? 0;
        stats.totalTokens += am.usage.totalTokens ?? 0;
        stats.totalCost += am.usage.cost?.total ?? 0;
      }
      for (const c of am.content) {
        if (c.type === "toolCall") {
          stats.toolCalls++;
          const n = (c as ToolCall).name;
          stats.toolsByName.set(n, (stats.toolsByName.get(n) ?? 0) + 1);
        }
      }
    }
  }

  if (stats.firstTs === Infinity) stats.firstTs = 0;
  return stats;
}

function renderSummary(stats: ThreadStats): string {
  const dur = stats.lastTs && stats.firstTs
    ? Math.round((stats.lastTs - stats.firstTs) / 1000)
    : 0;
  const durStr = dur > 0
    ? dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`
    : "\u2014";

  const toolBreakdown = [...stats.toolsByName.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `<div class="stat-row"><span class="stat-label">${esc(name)}</span><span class="stat-val">${count}</span></div>`)
    .join("\n");

  const fmt = (n: number) => n.toLocaleString();

  return `<aside class="sidebar">
  <div class="summary-section">
    <div class="summary-title">Cost</div>
    <div class="stat-row stat-hero"><span class="stat-label">total</span><span class="stat-val">$${stats.totalCost.toFixed(4)}</span></div>
  </div>

  <div class="summary-section">
    <div class="summary-title">Tokens</div>
    <div class="stat-row"><span class="stat-label">total</span><span class="stat-val">${fmt(stats.totalTokens)}</span></div>
    <div class="stat-row"><span class="stat-label">input</span><span class="stat-val">${fmt(stats.input)}</span></div>
    <div class="stat-row"><span class="stat-label">output</span><span class="stat-val">${fmt(stats.output)}</span></div>
    ${stats.cacheRead ? `<div class="stat-row"><span class="stat-label">cache read</span><span class="stat-val">${fmt(stats.cacheRead)}</span></div>` : ""}
    ${stats.cacheWrite ? `<div class="stat-row"><span class="stat-label">cache write</span><span class="stat-val">${fmt(stats.cacheWrite)}</span></div>` : ""}
  </div>

  <div class="summary-section">
    <div class="summary-title">Activity</div>
    <div class="stat-row"><span class="stat-label">turns</span><span class="stat-val">${stats.turns}</span></div>
    <div class="stat-row"><span class="stat-label">tool calls</span><span class="stat-val">${stats.toolCalls}</span></div>
    <div class="stat-row"><span class="stat-label">duration</span><span class="stat-val">${durStr}</span></div>
  </div>

  ${stats.toolCalls > 0 ? `<div class="summary-section">
    <div class="summary-title">Tools</div>
    ${toolBreakdown}
  </div>` : ""}

  <div class="summary-section">
    <div class="summary-title">Models</div>
    ${[...stats.models].map((m) => `<div class="stat-row"><span class="stat-val model-name">${esc(m)}</span></div>`).join("\n")}
  </div>
</aside>`;
}

// -- Result map --

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

// -- Tool renderers --

function renderBashCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const args = tc.arguments as { command?: string; label?: string };
  const cmd = args.command ?? "";
  const label = args.label;

  let outputHtml = "";
  if (result) {
    const text = truncate(extractText(result));
    const cls = result.isError ? " bash-output-error" : "";
    if (text.trim()) {
      outputHtml = `<pre class="bash-output${cls}">${esc(text)}</pre>`;
    } else if (result.isError) {
      outputHtml = `<pre class="bash-output bash-output-error">(error, no output)</pre>`;
    }
  }

  return `<div class="tool-call bash-call">
  ${label ? `<span class="tool-label">${esc(label)}</span>` : ""}
  <pre class="bash-cmd"><span class="bash-prompt">$</span> ${esc(cmd)}</pre>
  ${outputHtml}
</div>`;
}

function renderReadCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const args = tc.arguments as { path?: string; label?: string };
  const path = args.path ?? "";
  const label = args.label;

  let content = "";
  if (result) {
    const text = truncate(extractText(result));
    const cls = result.isError ? " file-output-error" : "";
    if (text.trim()) content = `<pre class="file-content${cls}">${esc(text)}</pre>`;
  }

  return `<div class="tool-call file-call">
  ${label ? `<span class="tool-label">${esc(label)}</span>` : ""}
  <div class="file-path">${esc(shortPath(path))}</div>
  ${content}
</div>`;
}

function renderWriteCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const args = tc.arguments as { path?: string; label?: string; content?: string };
  const path = args.path ?? "";
  const label = args.label;
  const written = args.content ?? "";
  const resText = result ? extractText(result) : "";

  return `<div class="tool-call file-call">
  ${label ? `<span class="tool-label">${esc(label)}</span>` : ""}
  <div class="file-path">${esc(shortPath(path))}</div>
  <details><summary>${written.split("\n").length} lines written</summary><pre class="file-content">${esc(truncate(written))}</pre></details>
  ${resText.trim() ? `<span class="file-confirm">${esc(resText.split("/").pop() ?? resText)}</span>` : ""}
</div>`;
}

function renderEditCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const args = tc.arguments as { path?: string; label?: string; old_string?: string; new_string?: string };
  const path = args.path ?? "";
  const label = args.label;
  const oldStr = args.old_string ?? "";
  const newStr = args.new_string ?? "";
  const resText = result ? extractText(result) : "";
  const isError = result?.isError;

  const confirmHtml = isError
    ? `<span class="file-confirm file-confirm-error">${esc(resText)}</span>`
    : resText.trim()
      ? `<span class="file-confirm">${esc(resText.split("/").pop() ?? resText)}</span>`
      : "";

  return `<div class="tool-call file-call">
  ${label ? `<span class="tool-label">${esc(label)}</span>` : ""}
  <div class="file-path">${esc(shortPath(path))}</div>
  <div class="diff">
    <pre class="diff-del">${esc(oldStr)}</pre>
    <pre class="diff-add">${esc(newStr)}</pre>
  </div>
  ${confirmHtml}
</div>`;
}

function renderUploadCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const args = tc.arguments as { path?: string; label?: string; comment?: string };
  const path = args.path ?? "";
  const label = args.label;
  const comment = args.comment;
  const resText = result ? extractText(result) : "";
  const filename = path.split("/").pop() ?? path;

  return `<div class="tool-call upload-call">
  ${label ? `<span class="tool-label">${esc(label)}</span>` : ""}
  <div class="upload-file">${esc(filename)}</div>
  ${comment ? `<span class="upload-comment">${esc(comment)}</span>` : ""}
  ${resText.trim() ? `<span class="file-confirm">${esc(resText)}</span>` : ""}
</div>`;
}

function renderGenericCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const argsStr = JSON.stringify(tc.arguments, null, 2) ?? "{}";

  let resultHtml = "";
  if (result) {
    const text = extractText(result);
    const out = truncate(text);
    if (out.trim()) {
      const errCls = result.isError ? " tool-result-error" : "";
      const errTag = result.isError ? `<span class="error-tag">error</span>` : "";
      resultHtml = `<div class="tool-result${errCls}">
        ${errTag}<details><summary>${text.length.toLocaleString()} chars</summary><pre>${esc(out)}</pre></details>
      </div>`;
    }
  }

  return `<div class="tool-call">
  <div class="tool-header"><span class="tool-name">${esc(tc.name)}</span></div>
  <details><summary>arguments</summary><pre>${esc(argsStr)}</pre></details>
  ${resultHtml}
</div>`;
}

const TOOL_RENDERERS: Record<string, (tc: ToolCall, result: ToolResultMessage | undefined) => string> = {
  bash: renderBashCall,
  read: renderReadCall,
  write: renderWriteCall,
  edit: renderEditCall,
  upload: renderUploadCall,
};

function renderToolCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const renderer = TOOL_RENDERERS[tc.name];
  return renderer ? renderer(tc, result) : renderGenericCall(tc, result);
}

// -- Message renderers --

function renderUserMessage(m: UserMessage): string {
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

function renderAssistantMessage(m: AssistantMessage, results: Map<string, ToolResultMessage>): string {
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

// -- Page --

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
<style>
:root {
  --bg:        #0d0d12;
  --surface:   #16161e;
  --surface-2: #1e1e28;
  --border:    #2a2a36;
  --text:      #c9c9d6;
  --text-dim:  #6e6e82;
  --text-faint:#4a4a5c;
  --blue:      #5b8def;
  --violet:    #a78bfa;
  --amber:     #e5a64e;
  --green:     #4ade80;
  --red:       #e55a5a;
  --red-dim:   #2c1a1a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace;
  background: var(--bg); color: var(--text);
  font-size: 13px; line-height: 1.6;
}
.layout {
  display: grid; grid-template-columns: 1fr 200px; gap: 16px;
  max-width: 1080px; margin: 0 auto; padding: 24px 16px;
}
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { position: static; order: -1; }
}
h1 {
  font-size: 12px; color: var(--text-dim); font-weight: 400;
  margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--border);
  letter-spacing: 0.5px; grid-column: 1 / -1;
}

/* Sidebar */
.sidebar {
  position: sticky; top: 24px; align-self: start;
}
.summary-section {
  margin-bottom: 16px; padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.summary-section:last-child { border-bottom: none; }
.summary-title {
  font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
  color: var(--text-faint); font-weight: 600; margin-bottom: 6px;
}
.stat-row {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 11px; padding: 1px 0;
}
.stat-label { color: var(--text-dim); }
.stat-val { color: var(--text); font-weight: 500; }
.stat-hero .stat-val { font-size: 16px; color: var(--amber); }
.model-name { font-size: 10px; color: var(--text-dim); }

/* Messages */
.thread { min-width: 0; }
.msg {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 6px; padding: 12px 14px; margin-bottom: 6px;
}
.msg-user { border-left: 2px solid var(--blue); }
.msg-assistant { border-left: 2px solid var(--violet); }
.msg-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
}
.role {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px;
  font-weight: 600;
}
.msg-user .role { color: var(--blue); }
.msg-assistant .role { color: var(--violet); }
.ts { font-size: 10px; color: var(--text-faint); }
pre {
  white-space: pre-wrap; word-break: break-word;
  font-size: 13px; line-height: 1.6; font-family: inherit;
}

/* Tool calls — shared */
.tool-call {
  margin: 8px 0; padding: 8px 10px;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px;
}
.tool-label {
  display: block; padding: 0 0 6px; margin-bottom: 6px;
  font-size: 11px; color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.tool-header { margin-bottom: 4px; }
.tool-name { font-size: 12px; font-weight: 600; color: var(--amber); }
.tool-result {
  margin-top: 6px; padding: 6px 8px;
  background: var(--bg); border-radius: 3px; border-left: 2px solid var(--border);
}
.tool-result-error { border-left-color: var(--red); }
.error-tag {
  display: inline-block; font-size: 10px; font-weight: 600; text-transform: uppercase;
  color: var(--red); letter-spacing: 0.5px; margin-bottom: 2px;
}
.msg-error {
  margin-top: 6px; padding: 6px 8px;
  background: var(--red-dim); border-left: 2px solid var(--red); border-radius: 3px;
  color: var(--red); font-size: 12px;
}

/* bash */
.bash-call { padding: 0; overflow: hidden; }
.bash-call .tool-label { padding: 6px 10px; margin: 0; }
.bash-cmd {
  padding: 8px 10px; margin: 0;
  color: var(--text); background: none;
}
.bash-prompt { color: var(--amber); user-select: none; margin-right: 4px; }
.bash-output {
  padding: 8px 10px; margin: 0;
  background: var(--bg); color: var(--text-dim);
  border-top: 1px solid var(--border); font-size: 12px;
}
.bash-output-error { color: var(--red); }

/* file tools */
.file-call { padding: 0; overflow: hidden; }
.file-call .tool-label { padding: 6px 10px; margin: 0; }
.file-path { padding: 4px 10px; font-size: 12px; color: var(--blue); }
.file-content {
  padding: 8px 10px; margin: 0;
  background: var(--bg); color: var(--text-dim);
  border-top: 1px solid var(--border); font-size: 12px;
}
.file-output-error { color: var(--red); }
.file-confirm {
  display: block; padding: 4px 10px;
  font-size: 11px; color: var(--text-faint);
  border-top: 1px solid var(--border);
}
.file-confirm-error { color: var(--red); }

/* diffs */
.diff { border-top: 1px solid var(--border); background: var(--bg); }
.diff pre { padding: 4px 10px; margin: 0; font-size: 12px; }
.diff-del { color: var(--red); }
.diff-del::before { content: "- "; color: var(--red); opacity: 0.5; }
.diff-add { color: var(--green); border-top: 1px dashed var(--border); }
.diff-add::before { content: "+ "; color: var(--green); opacity: 0.5; }

/* upload */
.upload-call { padding: 0; overflow: hidden; }
.upload-call .tool-label { padding: 6px 10px; margin: 0; }
.upload-file { padding: 6px 10px; font-size: 12px; color: var(--blue); }
.upload-file::before { content: "\\2191  "; color: var(--text-faint); }
.upload-comment {
  display: block; padding: 2px 10px 6px;
  font-size: 11px; color: var(--text-dim); font-style: italic;
}

/* thinking */
.thinking > summary { color: var(--amber); }
.thinking > pre { color: var(--text-dim); }

/* details */
details { margin-top: 6px; }
summary {
  cursor: pointer; font-size: 11px; color: var(--text-dim);
  letter-spacing: 0.3px; user-select: none;
}
summary:hover { color: var(--text); }
details > pre {
  margin-top: 4px; padding: 8px;
  background: var(--bg); border-radius: 3px;
  font-size: 12px; color: var(--text-dim);
}

/* meta */
.meta {
  display: flex; gap: 8px; margin-top: 8px;
  font-size: 10px; color: var(--text-faint);
}
.meta-warn { color: var(--amber); }
</style>
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
