# Agent Prototype Findings

Results from `apps/agent-prototype/` — a standalone test of the core agent loop: LLM integration, tool execution, tree-based message persistence, and context assembly.

## What We Tested

The full agent cycle end-to-end:

1. **Pi libraries on Bun** — `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` v0.53.0 (target Node >=20, untested on Bun)
2. **4 core tools** — read, write, edit, bash — within Pi's `AgentTool` interface
3. **SQLite message tree** — insert, parent linkage, recursive CTE context assembly, summary truncation
4. **Persistence + resume** — kill the process, restart, history loaded from SQLite
5. **Thread isolation** — multiple threads in one DB with independent histories
6. **Streaming** — token-by-token output + inline tool result display

## Findings

### Pi Libraries Work on Bun Without Issues

Zero compatibility problems. `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` v0.53.0 import, resolve, and execute on Bun 1.3.9 with no polyfills, no patches, no workarounds. The Anthropic SDK (transitive dep) streams correctly.

Verified:
- `getModel("anthropic", "claude-sonnet-4-5")` returns a typed model object
- `completeSimple()` makes a round-trip API call and returns an `AssistantMessage`
- `agentLoop()` drives the full tool-calling loop: prompt → LLM stream → tool execution → feed results back → repeat until no tool calls
- TypeBox schema validation works for tool parameters

### AgentTool Interface

Pi's tool interface is clean and sufficient for our needs. The shape:

```ts
interface AgentTool<TParameters extends TSchema> {
  name: string;
  description: string;
  label: string;
  parameters: TParameters;  // TypeBox schema
  execute: (toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult>;
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // sent back to LLM
  details: T;                                // for UI only, not sent to LLM
}
```

Key design points:
- `content` vs `details` separation is useful — tool output for the LLM can differ from what's displayed to the user
- `onUpdate` callback enables streaming tool progress (not used in prototype, available for stretch)
- TypeBox schemas give runtime validation + TypeScript inference from a single definition

### agentLoop Drives the Full Cycle

`agentLoop(prompts, context, config)` returns an `EventStream<AgentEvent, AgentMessage[]>` — an async iterable of events with a `.result()` promise for the final message array.

The event types that matter:
- `message_update` with `assistantMessageEvent.type === "text_delta"` — streaming text tokens
- `tool_execution_start` — tool name + args, for display
- `tool_execution_end` — tool result + error flag
- `agent_end` — all messages produced in this turn

The `config.convertToLlm` callback converts `AgentMessage[]` to the LLM's `Message[]` format. Default implementation: filter to `user | assistant | toolResult` roles. This is where custom message types (like our `summary`) would be mapped.

### SQLite Message Tree Works

Three tables (`_guppy_threads`, `_guppy_messages`, `_guppy_events`) with WAL mode. The tree-based message storage works exactly as designed in `primitives/state.md`.

**Insert**: Each message gets a UUID, `parent_id` = current leaf. Thread's `leaf_id` updated after insert.

**Context assembly via recursive CTE**:

```sql
WITH RECURSIVE context AS (
  SELECT rowid AS rn, *, 0 AS stop FROM _guppy_messages WHERE id = :leaf_id
  UNION ALL
  SELECT m.rowid AS rn, m.*, CASE WHEN m.role = 'summary' THEN 1 ELSE 0 END
  FROM _guppy_messages m
  JOIN context c ON m.id = c.parent_id
  WHERE c.stop = 0
)
SELECT id, thread_id, parent_id, role, content, created_at
FROM context ORDER BY rn
```

**Gotcha: use `rowid` for ordering, not `created_at`.** `Date.now()` can return identical timestamps for messages inserted in rapid succession (same millisecond). SQLite's auto-incrementing `rowid` is monotonic and reliable. The CTE walks from leaf to root, collecting messages, and `ORDER BY rn` restores chronological order.

**Summary truncation works.** When the CTE encounters a `summary` role message, it sets `stop = 1`, which prevents walking further. The summary is included as the effective context root. Old messages remain in the tree but aren't on the active path.

### Message Serialization

Content is stored as JSON text. The serialization strategy differs by role:
- **User messages**: store just the content (string or content array)
- **Assistant messages**: store the entire `AssistantMessage` object (preserves `usage`, `model`, `stopReason` for analytics)
- **Tool results**: store the entire `ToolResultMessage` object (preserves `toolName`, `isError`, `details`)

On load, user messages are reconstructed as `{ role: "user", content, timestamp }`. Assistant and tool result messages are deserialized directly.

### Persistence Across Restarts

Kill the process, restart, ask "What did we do last time?" — the agent recalls the full conversation. The SQLite DB retains all messages, the thread's `leaf_id` points to the last message, and the CTE reconstructs the context.

### Thread Isolation

Multiple threads share one SQLite database with independent histories. `/new` creates a fresh thread (new UUID, no messages). `/switch <prefix>` restores a previous thread's context. Verified that a new thread has no memory of other threads' conversations.

### Tool Implementation Notes

**Path sandboxing**: All file tools resolve paths against a `workspaceDir` and reject paths that escape it (e.g. `../../etc/passwd`). Uses `path.resolve()` + prefix check.

**Read**: `Bun.file(path).text()`, with optional line offset/limit. Returns numbered lines.

**Write**: `Bun.write(path, content)` with `mkdir -p` for parent directories.

**Edit**: String replacement. Reads file, validates `old_string` exists exactly once, replaces, writes back. Rejects if 0 or >1 matches.

**Bash**: `Bun.spawn(["bash", "-c", command])` with configurable timeout (default 30s), stdout+stderr capture, output truncation at 50KB. `cwd` set to workspace dir.

### CLI REPL

Minimal stdin/stdout loop using `for await (const line of console)`. Special commands:
- `/new` — create new thread
- `/threads` — list all threads with message counts
- `/switch <id-prefix>` — switch to a different thread

**HMR incompatibility**: `bun --hot` cannot reload a module that has a locked `ReadableStream` (stdin). Use `bun main.ts` without `--hot` for the CLI. This won't matter in production where the entry point is a server, not a REPL.

## Architecture Validated

The prototype confirms the architecture from the design docs works end-to-end:

```
User input → persist to SQLite → load context (CTE walk) → agentLoop() → stream events → persist results → update leaf
```

No blockers discovered. The Pi libraries, SQLite tree storage, and tool execution all work on Bun as designed.

## What's Not Covered

- Web UI / WebSocket transport (validated separately in web prototype)
- Skills / SKILL.md loading
- Event bus / scheduler
- Compaction (inserting summary nodes via LLM — the CTE handles them, but we didn't test the summarization step)
- Orchestrator / idle eviction
- Credentials management
- Context overflow handling (`isContextOverflow` utility exists in pi-ai but wasn't exercised)

## Pi API Reference (for implementors)

Key imports used:

```ts
// LLM layer
import { getModel, getEnvApiKey, completeSimple } from "@mariozechner/pi-ai";
import type { Model, Message, UserMessage, AssistantMessage, ToolResultMessage,
              TextContent, ImageContent, AssistantMessageEvent } from "@mariozechner/pi-ai";

// Agent layer
import { agentLoop } from "@mariozechner/pi-agent-core";
import type { AgentTool, AgentToolResult, AgentContext, AgentLoopConfig,
              AgentMessage, AgentEvent } from "@mariozechner/pi-agent-core";

// Schemas
import { Type } from "@sinclair/typebox";
```

`getModel("anthropic", "claude-sonnet-4-5")` — model IDs are string literals, fully type-checked against a generated registry. Available Anthropic IDs include `claude-sonnet-4-5`, `claude-sonnet-4-0`, `claude-opus-4-6`, `claude-haiku-4-5`, etc.

`getEnvApiKey("anthropic")` — reads `ANTHROPIC_API_KEY` from `process.env` (Bun auto-loads `.env`).

The `Agent` class (higher-level wrapper around `agentLoop`) is also available but wasn't used in the prototype. It manages state, subscriptions, and abort internally — useful for UI integrations.
