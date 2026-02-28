import type { ToolCall, ToolResultMessage } from "@guppy/core";
import { esc, extractText, shortPath, truncate } from "./helpers";

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

export function renderToolCall(tc: ToolCall, result: ToolResultMessage | undefined): string {
  const renderer = TOOL_RENDERERS[tc.name];
  return renderer ? renderer(tc, result) : renderGenericCall(tc, result);
}
