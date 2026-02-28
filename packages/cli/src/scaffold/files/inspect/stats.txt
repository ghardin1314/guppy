import type { AgentMessage, AssistantMessage, ToolCall } from "@guppy/core";
import { esc } from "./helpers";

export interface ThreadStats {
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

export function computeStats(messages: AgentMessage[]): ThreadStats {
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

export function renderSummary(stats: ThreadStats): string {
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
