# @guppy/core — Detailed Design

## Overview

`@guppy/core` is the agent runtime. It owns the LLM loop, tool execution, context management, memory, skills, events, and sandboxing. It is transport-agnostic — it receives a `Thread` from the chat SDK and operates through it.

**Exports**: `createOrchestrator`, `createStore`, `createEventBus`, `loadSkills`, `createSandbox`

---

## Orchestrator + Actor Model

All external input flows through a single **Orchestrator**, which routes messages to per-thread **Actors**. Actors are virtual — created on demand when the first message arrives, deactivated after idle timeout.

### Orchestrator

The orchestrator is the front door. Callers never interact with actors directly.

```typescript
interface Orchestrator {
  send(threadId: string, message: ActorMessage): void;
  sendToChannel(adapterId: string, channelId: string, text: string): void;
}
```

Two methods:
- **`send()`** — routes to a thread actor's mailbox. Fire-and-forget. Actor created on demand.
- **`sendToChannel()`** — posts a top-level message to a channel, creating a new thread. Then routes to a new actor via `send()`.

```typescript
function createOrchestrator(deps: {
  store: Store;
  chat: Chat;
  sandbox: Sandbox;
  config: Config;
}): Orchestrator
```

**`sendToChannel` flow:**
1. `chat.channel(channelId).post(text)` → `SentMessage` with `.threadId`
2. Construct lazy `Thread` via `new ThreadImpl({ id: sentMessage.threadId, adapterName: adapterId, channelId, isDM: false })`
3. `this.send(sentMessage.threadId, { type: "prompt", text, thread, message: sentMessage })`

This lives in the orchestrator because there's no thread actor yet — the thread doesn't exist until the channel post creates it.

**Virtual actor semantics**: `send()` never fails. If the actor doesn't exist yet, it's activated transparently. Callers don't know or care about actor lifecycle.

### Actor Messages

```typescript
type ActorMessage =
  | { type: "prompt"; text: string; thread: Thread; message: Message }
  | { type: "steer"; text: string }
  | { type: "abort" };
```

| Type | Source | Behavior |
|---|---|---|
| `prompt` | Chat SDK handlers, event bus, orchestrator (after channel post) | Queued — waits behind active run, triggers agent when dequeued |
| `steer` | `/steer` slash command | Bypass — injected into running agent immediately. Dropped if nothing running. |
| `abort` | `/stop` slash command | Bypass — cancels running agent immediately. Queued prompts behind it still execute. |

### Actor

One actor per thread ID. Owns its mailbox, agent lifecycle, and backpressure.

```typescript
interface Actor {
  readonly threadId: string;
  readonly mailbox: ActorMessage[];
  receive(message: ActorMessage): void;
}
```

#### Mailbox Processing

The actor's `receive()` method handles messages based on type:

```
receive(message):
  if message.type === "abort":
    → if agent running: agent.abort()
    → else: no-op
    → return

  if message.type === "steer":
    → if agent running: agent.steer(userMessage)
    → else: no-op (could post ephemeral "nothing running")
    → return

  if message.type === "prompt":
    → if prompt queue full (>= maxDepth):
        → post ephemeral "busy, try again later"
        → return
    → push to prompt queue
    → if not running: drainQueue()
```

#### Drain Loop

```
drainQueue():
  while prompt queue is not empty:
    item = queue.shift()
    activate if needed
    run agent with item
    save context
  deactivation timer starts
```

Each prompt gets its own agent run. The agent is created (or reused if still active), context is synced, and `agent.prompt(input)` is called.

#### Lifecycle

```
INACTIVE ──(first message)──→ ACTIVE ──(idle timeout)──→ INACTIVE
                                 ↑                           │
                                 └───(new message)───────────┘
```

**Activation** (INACTIVE → ACTIVE):
- Load context from store (`context.jsonl`)
- Read memory files (global + transport + channel)
- Load skills (global + transport + channel)
- Create pi-agent-core `Agent` instance
- Subscribe to `AgentEvent` stream
- Cache `Thread` reference from first prompt message

**Deactivation** (ACTIVE → INACTIVE after idle timeout):
- Save context to store
- Drop `Agent` instance
- Free memory
- Actor remains in orchestrator map (cheap — just the mailbox reference)
- Next message reactivates transparently

**Idle timeout**: configurable, default 5 minutes. Reset on every message.

#### Backpressure

The actor owns backpressure decisions:
- Max prompt queue depth: 5 (configurable)
- When full, incoming `prompt` messages get an ephemeral reply via the thread
- `steer` and `abort` always accepted (they bypass the queue)

#### Per-Actor State

```typescript
interface ActorState {
  threadId: string;
  promptQueue: Array<{ text: string; thread: Thread; message: Message }>;
  agent: Agent | null;            // pi-agent-core instance, null when inactive
  running: boolean;
  thread: Thread | null;          // cached from most recent prompt
  idleTimer: Timer | null;
}
```

### Usage in Scaffolded App

```typescript
// index.ts
const orchestrator = createOrchestrator({ store, chat, sandbox, config });

// Chat SDK handlers — fire and forget
chat.onNewMention(async (thread, message) => {
  store.logMessage(thread.id, message);
  orchestrator.send(thread.id, { type: "prompt", text: message.text, thread, message });
  await thread.subscribe();
});

chat.onSubscribedMessage(async (thread, message) => {
  store.logMessage(thread.id, message);
  orchestrator.send(thread.id, { type: "prompt", text: message.text, thread, message });
});

chat.onSlashCommand("/stop", async (event) => {
  orchestrator.send(threadId, { type: "abort" });
  await event.channel.postEphemeral(event.user.id, "Stopping.");
});

chat.onSlashCommand("/steer", async (event) => {
  orchestrator.send(threadId, { type: "steer", text: event.text });
  await event.channel.postEphemeral(event.user.id, "Steering message sent.");
});

// Event bus — same interface
eventBus.onEvent((event) => {
  orchestrator.send(event.threadId, { type: "prompt", text: event.text });
});
```

---

## Agent Runner

Built on pi-agent-core's `Agent` class, which owns the LLM loop, tool execution, steering, and follow-up queuing. One `Agent` instance per run (not reused across queue items).

### pi-agent-core `Agent` Class

The `Agent` class provides:

```typescript
class Agent {
  // Execution
  prompt(input: string): Promise<void>;      // start a run
  continue(): Promise<void>;                  // resume from current context

  // Mid-run control
  steer(message: AgentMessage): void;         // inject steering (checked between tool calls)
  followUp(message: AgentMessage): void;      // queue for after agent stops
  abort(): void;                              // cancel via AbortController

  // State
  setSystemPrompt(v: string): void;
  setModel(m: Model): void;
  setTools(t: AgentTool[]): void;
  replaceMessages(ms: AgentMessage[]): void;

  // Observation
  subscribe(fn: (e: AgentEvent) => void): () => void;
  waitForIdle(): Promise<void>;
}
```

### Configuration

We configure the `Agent` via `AgentOptions`:

```typescript
const agent = new Agent({
  convertToLlm,         // AgentMessage[] → Message[] at LLM boundary
  transformContext,      // context window management (compaction lives here)
  getApiKey,            // dynamic API key resolution per call
});

agent.setSystemPrompt(buildSystemPrompt({ dataDir, identity, memory, skills, sandbox, settings, threadMeta }));
agent.setTools(buildTools({ thread, store, sandbox }));
agent.replaceMessages(store.loadContext(threadId));
```

**Key hooks we implement:**

| Hook | Our implementation |
|---|---|
| `convertToLlm` | Filter out custom message types, convert `AgentMessage[]` → LLM-compatible `Message[]` |
| `transformContext` | Compaction — when tokens exceed threshold, summarize old messages, keep recent ones verbatim |
| `getApiKey` | Resolve API key from config (supports expiring tokens like GitHub Copilot OAuth) |

### Lifecycle

```
Actor drains prompt from queue
  → activate if needed (load context, create Agent)
  → sync context (backfill from thread messages into store)
  → configure Agent (system prompt, tools, messages)
  → subscribe to AgentEvents (for streaming to thread)
  → agent.prompt(input)
  → await agent.waitForIdle()
  → save context to store
  → drain next prompt (or start idle timer)
```

### Loop Structure (managed by pi-agent-core)

The `Agent` class manages two loops internally:

**Inner loop** (tool execution):
1. Call LLM with current context (after `transformContext` + `convertToLlm`)
2. Stream response
3. If stop reason = "end_turn" (no tool calls) → break
4. If stop reason = "error" or aborted → return
5. Execute tool calls sequentially
6. Between each tool: check steering queue (`getSteeringMessages`)
   - If steering exists → skip remaining tools, inject as user message
7. Continue to next LLM call

**Outer loop** (follow-up):
- After inner loop completes, check follow-up queue (`getFollowUpMessages`)
- If follow-up messages exist → continue with another turn
- Otherwise → done

### AgentEvent Stream

We subscribe to `AgentEvent`s to bridge the agent's output to the chat thread:

```typescript
agent.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      // Stream text deltas to thread via thread.post(asyncIterable)
      // or thread.startTyping() during tool execution
      break;
    case "message_end":
      // Final assistant message — post to thread if not already streaming
      break;
    case "tool_execution_start":
      thread.startTyping(`Running ${event.toolName}...`);
      break;
    case "turn_end":
      // Save context checkpoint
      store.saveContext(threadId, agent.state.messages);
      break;
  }
});
```

Key events:

| Event | What we do |
|---|---|
| `message_update` | Stream text deltas to thread (typing indicator + partial text) |
| `message_end` | Post final assistant message to thread |
| `tool_execution_start` | Show typing indicator with tool name |
| `tool_execution_end` | Log tool result |
| `turn_end` | Save context checkpoint to disk |
| `agent_end` | Final save, cleanup |

### Response Delivery

| Agent action | Chat SDK call |
|---|---|
| Stream text response | `thread.post(asyncIterable)` — SDK handles platform-specific streaming |
| Show typing during tools | `thread.startTyping(status)` |
| Upload file (via upload tool) | `thread.post({ file })` |

The chat SDK handles streaming differences per platform (native Slack streaming, post+edit fallback on others).

### Steering Integration

When the actor receives `{ type: "steer" }`, it calls `agent.steer(userMessage)` on the pi-agent-core `Agent` instance. The agent's internal loop checks for steering messages between each tool call via the `getSteeringMessages` config hook. When steering arrives:

1. Remaining tool calls from the current LLM response are skipped
2. Steering message injected as a user message in context
3. LLM called again with updated context

If the actor has no running agent, the steer message is dropped.

### Abort Handling

When the actor receives `{ type: "abort" }`, it calls `agent.abort()` on the pi-agent-core `Agent`:

- Signals the internal `AbortController` — cancels in-flight LLM streams and tool executions
- Tool execution aborted → process killed (entire process tree)
- Final `agent_end` event still emitted
- Context saved up to point of abort (partial work preserved in `turn_end`)
- Queued prompts behind the aborted run still execute

---

## Context Management

### Two-File Strategy

Each thread has two files in its data directory:

| File | Purpose | Format |
|---|---|---|
| `log.jsonl` | Append-only message history | Human-readable, no tool results |
| `context.jsonl` | LLM context | Full API messages (system, user, assistant, tool calls, tool results) |

`log.jsonl` is the source of truth for what happened. `context.jsonl` is the working set for the LLM. They diverge because:
- `log.jsonl` includes messages from all users, even while the agent wasn't running
- `context.jsonl` includes tool calls/results that aren't in the log
- `context.jsonl` gets compacted; `log.jsonl` never does

### Backfill / Sync

On each agent run, before the LLM loop starts:

1. **Fetch thread messages** via `thread.messages` (chat SDK's paginated async iterator)
2. **Diff against `log.jsonl`** — find messages not yet logged
3. **Append new messages to `log.jsonl`**
4. **Sync to `context.jsonl`** — inject missing user/bot messages into the LLM context

This ensures the agent sees messages that arrived while it wasn't running (e.g., a user posted 3 messages before the agent woke up).

Deduplication during sync:
- Match by message ID (from chat SDK's `Message.id`)
- Normalize text for comparison (strip timestamp prefixes, attachment sections)
- Skip bot's own messages (already in context from the previous run)

### Compaction

Implemented via pi-agent-core's `transformContext` hook, which runs before every LLM call. pi-agent-core has no built-in compaction — this is entirely our responsibility.

When context grows beyond a threshold:
- **Reserved tokens**: 16,384 (for system prompt + tools)
- **Kept recent tokens**: 20,000 (recent messages preserved verbatim)
- Older messages summarized by the LLM into a compact "previously..." block
- Automatic — `transformContext` checks token count on every call, compacts only when needed
- Configurable via global settings

### Channel Search

The agent needs a way to search messages beyond its thread. Exposed as a tool:

```typescript
// tools/search.ts
// Searches channel message history via chat SDK
{
  name: "search_channel",
  description: "Search messages in the current channel",
  parameters: {
    query: string,       // text to search for
    limit?: number,      // max results (default 20)
  },
  execute: async ({ query, limit }, { thread }) => {
    // Use thread.channel.messages (async iterator) to scan
    // Filter by query match
    // Return formatted results
  }
}
```

This uses the chat SDK's `Channel.messages` async iterator, which paginates through the platform's message history API.

---

## Store

The store manages per-thread filesystem state.

### Directory Layout

Data is organized hierarchically by transport → channel → thread:

```
data/
├── IDENTITY.md                           # Agent identity/personality
├── MEMORY.md                             # Global memory (all transports)
├── SYSTEM.md                             # Environment modification log
├── settings.json                         # Agent settings
├── events/                               # Event bus JSON files
├── skills/                               # Global skills
└── {adapter}/                            # Transport level
    ├── MEMORY.md                         # Transport memory
    ├── skills/                           # Transport-specific skills
    └── {channelId}/                      # Channel level
        ├── MEMORY.md                     # Channel memory
        ├── skills/                       # Channel-specific skills
        └── {threadId}/                   # Thread level
            ├── log.jsonl                 # Message history
            ├── context.jsonl             # LLM context
            ├── attachments/              # Downloaded files
            └── scratch/                  # Agent working directory
```

### Path Resolution

Chat SDK thread IDs are composite: `adapter:channel:thread` (e.g., `slack:C123ABC:1234567890.123456`). The store splits this into three path segments:

```typescript
function threadDir(dataDir: string, threadId: string): string {
  const [adapter, channelId, thread] = threadId.split(":");
  return join(dataDir, adapter, encode(channelId), encode(thread));
}
```

Channel and thread IDs are encoded for filesystem safety (e.g., characters like `/` in Google Chat's `spaces/ABC123` are escaped). Adapter names (`slack`, `teams`, etc.) are always safe.

### Message Logging

```typescript
interface LogEntry {
  date: string;          // ISO 8601
  messageId: string;     // chat SDK message ID
  userId: string;        // platform user ID
  userName: string;      // display name
  text: string;          // plain text content
  isBot: boolean;
  attachments?: Array<{ original: string; local: string }>;
}
```

- Append-only to `log.jsonl`
- Deduplication via message ID (tracked in memory with 60s TTL)
- Bot responses logged after posting (marked `isBot: true`)

### Attachment Handling

- Chat SDK `Message.attachments` provides URLs
- Downloaded to `attachments/{timestamp}_{filename}`
- Background download queue (one at a time, errors don't block)
- Local paths stored in log entry for agent access
- Images converted to base64 for LLM context; other files referenced by path

### Store API

```typescript
interface Store {
  // Path resolution
  threadDir(threadId: string): string;
  channelDir(threadId: string): string;
  transportDir(threadId: string): string;

  // Message logging
  logMessage(threadId: string, message: Message): void;

  // Context management
  loadContext(threadId: string): AgentMessage[];
  saveContext(threadId: string, messages: AgentMessage[]): void;

  // Attachments
  downloadAttachment(threadId: string, url: string, filename: string): Promise<string>;

  // Settings
  getSettings(): Settings;
}
```

---

## Memory

### Three Levels

| Scope | Path | Purpose |
|---|---|---|
| Global | `data/MEMORY.md` | Shared across all transports — preferences, learned facts |
| Transport | `data/{adapter}/MEMORY.md` | Platform-specific conventions, cross-channel knowledge |
| Channel | `data/{adapter}/{channelId}/MEMORY.md` | Channel-specific context — project details, ongoing work |

No thread-level memory. Threads are short-lived; `context.jsonl` handles conversation state.

### Read

All three files read fresh before every `agent.prompt()` call. Injected into the system prompt:

```
### Global Memory
{contents of data/MEMORY.md}

### Transport Memory ({adapterName})
{contents of data/{adapter}/MEMORY.md}

### Channel Memory
{contents of data/{adapter}/{channelId}/MEMORY.md}
```

Missing or empty files are omitted. If all three are empty: `"(no memory yet)"`.

### Write

The agent writes memory via its file tools (write/edit). No special memory API — it's just a file the agent knows about. The system prompt instructs the agent to use the narrowest scope that fits.

No automatic pruning. The agent manages its own memory content.

---

## Skills

### Discovery

Skills are markdown files (`SKILL.md`) with optional companion scripts, loaded from four locations:

| Scope | Path |
|---|---|
| Global | `data/skills/{skill-name}/SKILL.md` |
| Transport | `data/{adapter}/skills/{skill-name}/SKILL.md` |
| Channel | `data/{adapter}/{channelId}/skills/{skill-name}/SKILL.md` |

Narrower scopes override broader scopes by name (channel > transport > global).

### Format

```markdown
---
name: github-notify
description: Check GitHub notifications and report new ones
---

## Instructions
Check for new GitHub notifications using the gh CLI...

## Files
- check.sh — Run this to fetch notifications
```

YAML frontmatter for metadata. Body is free-form instructions injected into the system prompt.

### Loading

```typescript
function loadSkills(dataDir: string, threadId: string): Skill[] {
  const [adapter, channelId] = threadId.split(":");
  const global = loadSkillsFromDir(join(dataDir, "skills"));
  const transport = loadSkillsFromDir(join(dataDir, adapter, "skills"));
  const channel = loadSkillsFromDir(join(dataDir, adapter, encode(channelId), "skills"));
  // Narrower scopes override broader by name
  const merged = new Map<string, Skill>();
  for (const s of global) merged.set(s.name, s);
  for (const s of transport) merged.set(s.name, s);
  for (const s of channel) merged.set(s.name, s);
  return [...merged.values()];
}
```

### System Prompt Integration

Skills formatted via `formatSkillsForPrompt()` and appended to the system prompt. Each skill's instructions are embedded so the LLM knows how to use them.

### Path Translation

In Docker sandbox mode, host paths are translated to container paths (`/workspace/...`) so the agent references files correctly inside the container.

---

## Sandbox

Abstraction over command execution — host (direct) or Docker (isolated).

### Interface

```typescript
interface Sandbox {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  workspacePath: string;   // where the agent's files live (host path or /workspace)
}

interface ExecOptions {
  timeout?: number;        // ms, default 120_000
  signal?: AbortSignal;
  cwd?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}
```

### Host Executor

- Spawns shell process (`sh -c` on Unix)
- stdout/stderr buffered (max 10MB each, truncated with notice)
- Timeout via `setTimeout` + `killProcessTree()`
- Abort via `AbortSignal` listener → kill process tree
- Workspace path = actual filesystem path to thread's `scratch/` dir

### Docker Executor

- Wraps commands as `docker exec {container} sh -c '{command}'`
- Delegates to host executor for actual spawn
- Workspace path = `/workspace` (mounted volume)
- Container managed externally (not created/destroyed per run)

### Output Truncation

Tool results (stdout/stderr) truncated to fit within context window budget. Large outputs written to a temp file, with a truncation notice and file path in the tool result so the agent can read the full output if needed.

---

## Tools

Standard tool set, available to every agent run:

### `bash`
Shell execution via sandbox. Streams output for long-running commands. Truncates large output (writes full output to temp file). Respects abort signal.

### `read`
Read file contents. Supports line range (`offset`, `limit`). Returns with line numbers.

### `write`
Write file contents. Creates parent directories. Used for creating new files and full rewrites.

### `edit`
Surgical string replacement in files. Requires `old_string` to be unique in the file. Supports `replace_all` for bulk renames.

### `upload`
Upload a file to the current thread. Takes a file path (relative to workspace or absolute), posts it via `thread.post({ file })`. Supports optional `comment` parameter sent as message text alongside the file.

### `search_channel`
Search channel message history via chat SDK. Uses `thread.channel.messages` async iterator with text filtering. Returns formatted message excerpts with timestamps and authors.

---

## Event Bus

Watches `data/events/` for JSON event files. Three types:

### Event Types

| Type | Trigger | Use Case |
|---|---|---|
| `immediate` | File appears | Webhooks, external signals |
| `one-shot` | Specific ISO 8601 time | Reminders, scheduled tasks |
| `periodic` | Cron schedule | Recurring checks, reports |

### Event File Format

**Existing thread** — message routed to an existing thread's actor:

```json
{
  "type": "periodic",
  "threadId": "slack:C123ABC:1234567890.123456",
  "text": "Check for new GitHub notifications",
  "schedule": "0 9 * * 1-5",
  "timezone": "America/New_York"
}
```

**New thread** — posts to channel, creates a new thread, then runs agent in it:

```json
{
  "type": "one-shot",
  "channelId": "C123ABC",
  "adapterId": "slack",
  "text": "Time for the weekly report",
  "schedule": "2025-03-01T09:00:00",
  "timezone": "America/New_York"
}
```

Events with `threadId` dispatch via `orchestrator.send()`. Events with `channelId` + `adapterId` (no `threadId`) dispatch via `orchestrator.sendToChannel()` — the orchestrator posts to the channel, gets the new thread ID, and routes to a new actor.

### Processing

- `fs.watch` on `data/events/` with 100ms debounce
- Existing files scanned on startup
- JSON parsed with retry (3 attempts, exponential backoff) for partial writes
- Events dispatched to orchestrator via `orchestrator.send()`
- Actor handles backpressure (max 5 queued prompts per thread)

---

## Integration with Chat SDK

### Handler Wiring (in scaffolded index.ts)

```
Webhook arrives
  → Chat SDK deduplicates, acquires 30s lock, dispatches handler
  → Our handler: log message + orchestrator.send() + return immediately
  → SDK releases lock (< 1ms held)
  → Actor processes work asynchronously
```

The handlers are thin bridges — see [Orchestrator usage example](#usage-in-scaffolded-app) above.

### What the SDK Owns vs What Core Owns

| Concern | Owner |
|---|---|
| Webhook verification, parsing | Chat SDK (adapter) |
| Message deduplication | Chat SDK (StateAdapter) |
| Handler dispatch lock (30s) | Chat SDK (irrelevant to us) |
| Thread subscriptions | Chat SDK (StateAdapter) |
| Message posting/editing/deleting | Chat SDK (Thread) |
| Streaming | Chat SDK (Thread.post with AsyncIterable) |
| **Message routing** | **@guppy/core (Orchestrator)** |
| **Concurrency / backpressure** | **@guppy/core (Actor)** |
| **LLM loop** | **@guppy/core (Agent via pi-agent-core)** |
| **Context management** | **@guppy/core (Store + context sync)** |
| **Tool execution** | **@guppy/core (Sandbox + tools)** |
| **Memory / Skills / Events** | **@guppy/core** |

---

## Decisions Log

| Decision | Choice | Rationale |
|---|---|---|
| Routing model | Orchestrator + virtual actors | Single `send()` entry point for all input sources. Actors created on demand, deactivated after idle. Callers never manage actor lifecycle. |
| Concurrency mechanism | Actor mailbox (Option A) | SDK lock is 30s, agent runs take minutes. Handlers return fast, actor manages sequencing. Distributed locking can layer on later (Option C) if needed. |
| Message routing | `steer`/`abort` bypass prompt queue | Actor processes these immediately against the running agent. Prompts queue behind active run. |
| Steering | Mid-run message injection | Checked between tool calls. Remaining tools skipped, LLM re-invoked with steering context. Never a system prompt rewrite. |
| Thread scoping | Thread-based, not channel-based | One actor per thread ID. Data dirs use hierarchical layout (`data/{adapter}/{channel}/{thread}/`). Each thread gets its own context and skills. Memory is global + transport + channel (no thread-level memory). |
| Context backfill | Sync from chat SDK + log.jsonl | Fetch thread messages via SDK on each run, diff against log, backfill missing messages into LLM context. |
| Channel search | Tool-based | Agent can search broader channel history via `search_channel` tool using chat SDK's message iterator. |
| New thread creation | `orchestrator.sendToChannel()` | Orchestrator posts to channel via `chat.channel(id).post()`, gets `SentMessage.threadId`, constructs lazy Thread, routes to new actor. Actors only deal with threads that already exist. |
