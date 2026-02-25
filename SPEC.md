# Guppy Chat — Project Spec

## References

| Repo / Doc | Path | Description |
|---|---|---|
| [badlogic/pi-mono](https://github.com/badlogic/pi-mono) | `.context/pi-mono/` | Mom bot + pi-agent-core |
| [vercel/chat](https://github.com/vercel/chat) | `.context/` (root) | Chat SDK — adapters, state, types |
| @guppy/core design | `docs/core-design.md` | Detailed design: orchestrator, actors, agent runner, context, tools |

---

## Vision

A CLI tool (`create-guppy-chat`) that scaffolds transport-independent AI chat agents. Users pick their transports (Slack, Teams, Discord, etc.), and the CLI generates a ready-to-run bun project with the correct webhook routes, adapter config, and agent wiring.

The scaffolded agent gets the **operational power of mom** (bash execution, skills, event bus, memory, context management) with the **platform abstraction of the chat SDK** — out of the box.

Everything we build — `@guppy/core`, `@guppy/web` — exists to make the scaffolded app work. The CLI is the product.

---

## What Gets Scaffolded

```
? Project name: my-agent
? Which transports? (multi-select)
  ◉ Slack
  ◯ Microsoft Teams
  ◯ Google Chat
  ◯ Discord
? State backend?
  ◉ Memory (development)
  ◯ Redis (production)
? Sandbox mode?
  ◉ Host (direct execution)
  ◯ Docker (isolated container)
```

Output (example: Slack selected):

```
my-agent/
├── src/
│   ├── index.ts              # Entry point (bun --hot compatible)
│   ├── config.ts             # Type-safe env config (only selected transport vars)
│   ├── procedures/
│   │   ├── index.ts          # Router composition (only selected transports)
│   │   ├── health.ts         # GET /health
│   │   └── webhooks/
│   │       └── slack.ts      # POST /webhooks/slack
├── data/                     # Runtime data (gitignored)
│   ├── MEMORY.md
│   ├── events/
│   └── skills/               # Global skills (agent-created)
├── my-agent.service          # systemd unit file (generated with correct paths)
├── .env.example              # Required env vars for selected transports only
├── package.json              # scripts: { dev: "bun --hot src/index.ts" }
├── tsconfig.json
└── Dockerfile                # Only if Docker sandbox selected
```

The user owns all scaffolded files — they can add routes, modify handlers, add transports, etc. The CLI just gets you started fast.

---

## Scaffolded Code

### `src/index.ts` — Entry Point

```typescript
import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createStore, createOrchestrator, createEventBus } from "@guppy/core";
import { createServer } from "@guppy/web";
import { router } from "./procedures";
import { config } from "./config";

const chat = new Chat({
  userName: config.botName,
  adapters: {
    slack: createSlackAdapter({
      botToken: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
    }),
  },
  state: createMemoryState(),
});

const store = createStore({ dataDir: config.dataDir });
const orchestrator = createOrchestrator({ store, chat, config });
const eventBus = createEventBus({ dataDir: config.dataDir, orchestrator });

// Chat SDK handlers — fire and forget to orchestrator
chat.onNewMention(async (thread, message) => {
  store.logMessage(thread.id, message);
  orchestrator.send(thread.id, { type: "prompt", text: message.text, thread, message });
  await thread.subscribe();
});

chat.onSubscribedMessage(async (thread, message) => {
  store.logMessage(thread.id, message);
  orchestrator.send(thread.id, { type: "prompt", text: message.text, thread, message });
});

// Slash commands — agent control
chat.onSlashCommand("/stop", async (event) => {
  const threadId = event.channel.id; // resolve active thread
  orchestrator.send(threadId, { type: "abort" });
  await event.channel.postEphemeral(event.user.id, "Stopping.");
});

chat.onSlashCommand("/steer", async (event) => {
  const threadId = event.channel.id;
  orchestrator.send(threadId, { type: "steer", text: event.text });
  await event.channel.postEphemeral(event.user.id, "Steering message sent.");
});

// Start server — injects context into all procedures
createServer({
  router,
  context: { chat, store, orchestrator, eventBus },
  port: config.port,
});

console.log(`Guppy listening on :${config.port}`);
```

### `src/procedures/` — oRPC Routes

The CLI generates only the routes for selected transports + a health check.

```typescript
// src/procedures/webhooks/slack.ts
import { procedure } from "@guppy/web";

export const slack = procedure
  .route({ method: "POST", path: "/webhooks/slack" })
  .handler(async ({ context, request }) => {
    return context.chat.webhooks.slack(request);
  });
```

```typescript
// src/procedures/health.ts
import { procedure } from "@guppy/web";

export const health = procedure
  .route({ method: "GET", path: "/health" })
  .handler(({ context }) => ({
    status: "ok",
    uptime: process.uptime(),
    transports: Object.keys(context.chat.adapters),
  }));
```

```typescript
// src/procedures/index.ts — only imports for selected transports
import { health } from "./health";
import { slack } from "./webhooks/slack";

export const router = {
  health,
  webhooks: { slack },
};

export type Router = typeof router;
```

---

## Packages We Build

Everything below powers the scaffolded app. Users don't interact with these directly — the CLI wires them in.

### Package Structure

```
guppy-chat/
├── packages/
│   ├── core/                    # @guppy/core — Agent runtime
│   │   ├── src/
│   │   │   ├── orchestrator.ts  # Message router — virtual actor management
│   │   │   ├── actor.ts         # Per-thread actor — mailbox, agent lifecycle
│   │   │   ├── agent.ts         # Agent configuration (wraps pi-agent-core Agent)
│   │   │   ├── context.ts       # Context sync, compaction (transformContext hook)
│   │   │   ├── store.ts         # Thread store (log.jsonl, attachments)
│   │   │   ├── memory.ts        # MEMORY.md management
│   │   │   ├── events.ts        # Event bus (immediate, one-shot, periodic)
│   │   │   ├── skills.ts        # Skill discovery and loading
│   │   │   ├── sandbox.ts       # Host/Docker executor abstraction
│   │   │   └── tools/
│   │   │       ├── bash.ts      # Shell execution with truncation
│   │   │       ├── read.ts      # File reading
│   │   │       ├── write.ts     # File writing
│   │   │       ├── edit.ts      # Surgical file editing
│   │   │       └── upload.ts    # File upload to thread
│   │   └── package.json
│   │
│   ├── web/                     # @guppy/web — oRPC server glue
│   │   ├── src/
│   │   │   ├── index.ts         # Exports: createServer, GuppyContext, procedure
│   │   │   ├── context.ts       # GuppyContext type definition
│   │   │   ├── server.ts        # createServer(router, context) → Bun.serve
│   │   │   └── lib.ts           # Base procedure with context typing
│   │   └── package.json
│   │
│   └── cli/                     # create-guppy-chat — Scaffolding CLI
│       ├── src/
│       │   ├── index.ts         # Entry point
│       │   ├── prompts.ts       # Interactive prompts (transport selection, etc.)
│       │   ├── scaffold.ts      # Project generation
│       │   └── templates/       # Template files per transport
│       └── package.json
│
├── bun.lock
└── package.json
```

### `@guppy/core` — Agent Runtime

The brain. Ported from mom, made transport-agnostic. See `docs/core-design.md` for detailed design.

**Exports**: `createOrchestrator`, `createStore`, `createEventBus`, `loadSkills`, `createSandbox`

Uses an **orchestrator + virtual actor** model: external input (webhooks, events, slash commands) flows through the orchestrator, which routes messages to per-thread actors. Actors manage their own mailbox, agent lifecycle, and backpressure. Does not know about Slack, Teams, etc. — receives a `Thread` from the chat SDK and operates through it.

### `@guppy/web` — Server Glue

Thin layer connecting oRPC to the agent runtime.

```typescript
// @guppy/web/src/context.ts
import type { Chat } from "chat";
import type { EventBus, Store, Orchestrator } from "@guppy/core";

export interface GuppyContext {
  chat: Chat;
  store: Store;
  orchestrator: Orchestrator;
  eventBus: EventBus;
}
```

```typescript
// @guppy/web/src/lib.ts
import type { GuppyContext } from "./context";
import { os } from "@orpc/server";

export const procedure = os.$context<GuppyContext>();
```

**Exports**: `procedure`, `GuppyContext`, `createServer`

### `create-guppy-chat` — CLI

The product. Asks questions, generates a project. Responsible for:

- Selecting which transport webhook routes to generate
- Generating `procedures/index.ts` with correct imports
- Generating `config.ts` with only the relevant env vars
- Generating `.env.example` matching selected transports
- Adding correct `@chat-adapter/*` dependencies to `package.json`
- Generating systemd unit file (`{project-name}.service`) with correct paths and user
- Optionally generating `Dockerfile` for sandbox mode

---

## Architecture (of a Scaffolded App)

```
┌──────────────────────────────────────────────────────────────┐
│                         bun --hot                             │
│                                                               │
│  ┌──────────────┐    ┌────────────────────────────┐           │
│  │  oRPC Router │    │      Chat SDK (core)        │           │
│  │              │    │                              │           │
│  │ POST /slack  │───▶│  Adapter: Slack              │           │
│  │ POST /teams  │───▶│  Adapter: Teams              │           │
│  │ POST /gchat  │───▶│  Adapter: Google Chat        │           │
│  │ POST /discord│───▶│  Adapter: Discord            │           │
│  │              │    │                              │           │
│  │              │    │  State: Memory | Redis       │           │
│  │ GET  /health │    └────────────┬─────────────────┘           │
│  └──────────────┘                 │                              │
│                                   ▼                              │
│                    ┌──────────────────────────┐                  │
│                    │      Orchestrator         │◀── Event Bus    │
│                    │   send() / sendToChannel()│    (FS watcher) │
│                    └─────┬────────┬────────┬──┘                  │
│                          │        │        │                      │
│                          ▼        ▼        ▼                      │
│                    ┌────────┐┌────────┐┌────────┐                │
│                    │ Actor  ││ Actor  ││ Actor  │  (per thread)  │
│                    │        ││        ││        │                │
│                    │ mailbox││ mailbox││ mailbox│                │
│                    │ agent  ││ agent  ││ agent  │                │
│                    └───┬────┘└───┬────┘└───┬────┘                │
│                        │         │         │                      │
│                        ▼         ▼         ▼                      │
│                    ┌──────────────────────────────┐               │
│                    │     pi-agent-core Agent       │               │
│                    │  • LLM loop                   │               │
│                    │  • Tools (bash, read, etc.)    │               │
│                    │  • Context / compaction        │               │
│                    │  • Memory / Skills             │               │
│                    │  • Sandbox (host/docker)       │               │
│                    └──────────────────────────────┘               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Feature Parity with Mom

### Must-Have (P0)

| Feature | Mom Implementation | Guppy Implementation |
|---|---|---|
| **Bash execution** | `tools/bash.ts` — shell exec with output truncation, temp files | Same, via `sandbox.ts` executor abstraction |
| **File tools** | read, write, edit, attach | read, write, edit, upload (via chat SDK's `thread.post({ file })`) |
| **Context management** | `context.ts` — log.jsonl ↔ context.jsonl sync, compaction | Same file-based approach, thread-keyed. Compaction via pi-agent-core's `transformContext` hook |
| **Memory system** | Global + per-channel MEMORY.md | Global + per-thread MEMORY.md |
| **Skills** | SKILL.md + scripts in `skills/` dirs | Same discovery, same format |
| **Event bus** | FS-watched `events/` dir, cron/one-shot/immediate | Same, dispatches to orchestrator. Supports both existing threads and new thread creation |
| **Per-thread queue** | Sequential processing per channel, max 5 queued | Virtual actor per thread with mailbox. Sequential prompt processing, steer/abort bypass queue |
| **Stop command** | "stop" bypasses queue, aborts current run | `/stop` slash command → `orchestrator.send(id, { type: "abort" })` |
| **Sandbox** | Host or Docker executor | Same |
| **Attachment handling** | Download files, store locally, expose to agent | Same via chat SDK's attachment support |
| **Message logging** | Append-only log.jsonl per channel | Same, per thread |

### New Capabilities (from Chat SDK)

| Feature | Description |
|---|---|
| **Multi-transport** | Slack + Teams + GChat + Discord from same instance |
| **Cards/modals** | JSX-based rich UI (buttons, forms, modals) |
| **Streaming** | Native Slack streaming, post+edit fallback on others |
| **Distributed locking** | Redis-backed thread locks (prevents concurrent processing) |
| **Thread subscriptions** | Persistent subscribe/unsubscribe via StateAdapter |
| **Format normalization** | mdast AST for cross-platform formatting |

### Deferred (P1)

| Feature | Notes |
|---|---|
| **Channel backfill** | Fetching message history on startup — use chat SDK's `fetchMessages` |
| **Multi-workspace** | Slack OAuth multi-workspace support (chat SDK supports this) |
| **Ephemeral messages** | Platform-dependent, nice-to-have |

---

## Transport Adapter Bridge

The key integration point: bridging chat SDK's handler model to the agent core. Handlers are thin — they log the message and fire-and-forget to the orchestrator. All agent lifecycle management happens inside actors. This wiring is scaffolded into the user's `index.ts` (see scaffolded code above).

### Response Adapter

Mom's `SlackContext` methods map to chat SDK's `Thread`:

| Mom (`SlackContext`) | Guppy (`Thread`) |
|---|---|
| `respond(text)` | `thread.post(text)` |
| `respondInThread(text)` | `thread.post(text)` (already in thread context) |
| `replaceMessage(text)` | `thread.editMessage(id, text)` |
| `setTyping()` | `thread.startTyping()` |
| `uploadFile(file)` | `thread.post({ file })` |
| `deleteMessage(ts)` | `thread.deleteMessage(id)` |

---

## systemd Service

The CLI generates a systemd unit file for running the agent as a daemon. The file is templated with the project name, working directory, and user.

Generated `my-agent.service` (user-level — no sudo required):

```ini
[Unit]
Description=my-agent
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/my-agent
ExecStart=%h/.bun/bin/bun run src/index.ts
Restart=always
EnvironmentFile=%h/my-agent/.env

[Install]
WantedBy=default.target
```

Install and start:

```bash
# Copy to user systemd dir
mkdir -p ~/.config/systemd/user
cp my-agent.service ~/.config/systemd/user/

# Enable (auto-start on login) and start
systemctl --user enable my-agent
systemctl --user start my-agent

# Check status
systemctl --user status my-agent

# Optional: keep running after logout (requires loginctl)
loginctl enable-linger $USER
```

---

## Hot Reload Strategy

`bun --hot` preserves the module graph and re-executes changed modules without restarting the process. Key considerations:

1. **Server socket**: Use `Bun.serve` with `reusePort` — hot reload replaces the fetch handler without dropping the listener
2. **Agent state**: Active agent runs are in-memory. Hot reload during an active run is safe because the running closure captures its own references
3. **Event bus**: Cron jobs and timers survive reload since they're held by the event loop, not module scope. Re-registration on reload needs dedup logic
4. **Chat SDK instance**: Re-created on reload, but stateless (state lives in StateAdapter). Webhook handlers re-register cleanly

```typescript
// src/index.ts — bun --hot compatible
const server = Bun.serve({
  port: 3000,
  fetch: router.handler, // replaced on hot reload
});

// Cleanup on hot reload
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    eventBus.stop();
  });
}
```

---

## Event Bus

Mom's event bus watches a filesystem directory and creates synthetic Slack events. Guppy's version:

1. **Same FS-watching approach** — drop JSON files into `data/events/`, they get picked up
2. **Dispatches to orchestrator** — events call `orchestrator.send()` or `orchestrator.sendToChannel()`
3. **Two targeting modes** — events can target an existing thread or create a new thread in a channel

```typescript
// Existing thread — dispatches via orchestrator.send()
{
  "type": "periodic",
  "threadId": "slack:C123ABC:1234567890.123456",
  "text": "Check for new GitHub notifications",
  "schedule": "0 9 * * 1-5",
  "timezone": "America/New_York"
}

// New thread — dispatches via orchestrator.sendToChannel()
{
  "type": "one-shot",
  "adapterId": "slack",
  "channelId": "C123ABC",
  "text": "Time for the weekly report",
  "schedule": "2025-03-01T09:00:00",
  "timezone": "America/New_York"
}
```

See `docs/core-design.md` for full event bus details.

---

## Data Directory Layout

```
data/
├── MEMORY.md                           # Global memory
├── SYSTEM.md                           # Environment log
├── settings.json                       # Agent settings
├── events/                             # Event bus JSON files
├── skills/                             # Global skills
│   └── github-notify/
│       ├── SKILL.md
│       └── check.sh
└── threads/
    └── {encoded-thread-id}/            # Per-thread storage
        ├── MEMORY.md                   # Thread-specific memory
        ├── log.jsonl                   # Message history
        ├── context.jsonl               # LLM context (compacted)
        ├── attachments/                # Downloaded files
        ├── scratch/                    # Working directory
        └── skills/                     # Thread-specific skills
```

---

## Key Differences from Mom

| Aspect | Mom | Guppy |
|---|---|---|
| **Transport** | Slack Socket Mode only | Any chat SDK adapter (webhook-based) |
| **Process model** | Slack WebSocket → internal queue | HTTP server → oRPC → chat SDK → orchestrator → actors |
| **Thread identity** | Slack channel ID | Chat SDK thread ID (`adapter:channel:thread`) |
| **Message format** | Raw Slack text | Normalized mdast AST |
| **Runtime** | Node.js | Bun |
| **Hot reload** | Restart process | `bun --hot` (in-process) |
| **Event injection** | Filesystem only | Filesystem only (same) |
| **State** | In-memory maps | Pluggable StateAdapter (memory/Redis) |
| **Agent framework** | `@mariozechner/pi-agent-core` | Same — `@mariozechner/pi-agent-core` |

---

## Open Questions

1. **Endpoint exposure**: How do webhook endpoints get exposed to the internet?
   - **Option A**: Direct — Bun HTTP server binds a port, user handles DNS/TLS/firewall themselves (simple, self-hosted)
   - **Option B**: Cloudflare Tunnel — `cloudflared` exposes localhost automatically, no port forwarding needed (zero-config networking)
   - **Option C**: Both — scaffold with direct server, optionally generate a `cloudflared` config for tunnel mode
   - Affects dev experience (tunnels simplify local testing with real webhooks) and production deployment story

2. **Secrets management**: Use `Bun.secrets` (OS keychain) vs `.env` files vs both?
   - `Bun.secrets` reads at call time (hot-reload friendly), but experimental and needs libsecret on headless Linux
   - `.env` + systemd `EnvironmentFile` is standard but requires restart to pick up changes
   - Could fall back: `await Bun.secrets.get(...) ?? Bun.env.X`
   - Explore during implementation once we see real usage patterns

---

## Resolved Decisions

- **Agent framework**: `@mariozechner/pi-agent-core` (`Agent` class — manages LLM loop, steering, follow-ups)
- **Transport**: Webhooks only (no Socket Mode)
- **Package manager**: Bun workspaces monorepo
- **Instance model**: Single instance only
- **Routing model**: Orchestrator + virtual actors (one per thread, created on demand)
- **Concurrency**: Actor mailbox is sole mechanism — SDK's 30s lock is irrelevant (handlers return immediately)
- **Steering**: Mid-run message injection via `agent.steer()` — never a system prompt rewrite
- **Scoping**: Thread-based, not channel-based — each thread gets its own actor, context, memory, skills
- **New thread creation**: `orchestrator.sendToChannel()` — posts to channel, gets thread ID, routes to new actor
