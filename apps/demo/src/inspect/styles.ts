export const INSPECT_CSS = `
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
`;
