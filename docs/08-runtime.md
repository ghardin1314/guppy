# Runtime

Everything runs in a single Bun process. A shared runtime object wires the pieces together.

## The Runtime Object

```ts
interface GuppyRuntime {
  db: Database;
  orchestrator: Orchestrator;
  eventBus: EventBus;
}
```

Created once at boot, passed to everything that needs it. No globals, no singletons.

## Boot Sequence

`project/start.ts` is the entry point (equivalent to `guppy start`):

```ts
import { boot } from "guppy";
import shell from "./shell.html";

await boot(import.meta.dir, shell);
```

Inside `boot()`:

```
1. db = openDatabase(projectDir/guppy.db)
         ↓
2. orchestrator = new Orchestrator(db, projectDir)
         ↓
3. eventBus = new EventBus(db, orchestrator)
         ↓
4. runtime = { db, orchestrator, eventBus }
         ↓  (parallel from here)
   ┌─────┼──────────────┬───────────────┐
   ↓     ↓              ↓               ↓
 bootTransports   eventBus.        createServer     startAutoCommit
  (runtime)       startScheduler()  (runtime, shell)  (projectDir)
```

Steps 1-3 are sequential — each depends on the previous. Step 4 fans out in parallel since all four just need the runtime to exist.

## Orchestrator

The central router. All message sources go through it, all responses come back through it. It manages:

- **Thread map** — which agent threads are loaded in memory
- **Per-thread mailbox** — sequential processing queue per thread
- **Subscriber map** — who's listening to which thread's events

### Interface

```ts
class Orchestrator {
  send(threadId: string, message: MailboxMessage): void
  subscribe(threadId: string, callback: (event: AgentEvent) => void): () => void
  getOrCreateThread(transport: string, channelId: string): string  // returns threadId
}
```

Three methods. That's the entire surface area everything else touches.

### Message Flow

```
orchestrator.send(threadId, msg)
  → is thread in memory? no → rehydrate from SQLite
  → enqueue msg in thread's mailbox
  → if thread idle → start processing

thread processes message:
  → load context via recursive CTE
  → call agentLoop()
  → for each streaming event → fan out to all subscribers
  → persist results to SQLite
  → dequeue next mailbox message (or go idle)
```

### Subscriber-Based Delivery

The orchestrator doesn't know or care who sent a message. It doesn't route responses "back to the originating transport." Instead, delivery is subscription-based:

- Slack transport subscribes to all slack-originated threads
- WebSocket connections subscribe to whatever thread the user is viewing
- The orchestrator fans out events to all subscribers of a thread

A Slack thread with a browser viewer open gets events delivered to both — the operator sees the same conversation in the UI. This is correct.

### Thread Processing

Threads process mailbox messages sequentially — one at a time. But multiple threads can run in parallel (each `agentLoop()` call is an independent async task). SQLite WAL mode handles concurrent reads.

**Prompt** and **follow-up** messages queue normally. **Steering** and **stop** messages interrupt the active agent loop immediately (via AbortSignal or Pi's steering mechanism).

## How Each Piece Gets the Runtime

### Web Server

`createServer(projectDir, shell, runtime)` — the runtime is closed over by the WebSocket and API route handlers.

**WebSocket** is the "web" transport — operator sends prompts, subscribes to thread events:

```ts
websocket: {
  message(ws, raw) {
    const msg = JSON.parse(raw);
    if (msg.type === "subscribe") {
      const unsub = runtime.orchestrator.subscribe(msg.threadId, (event) => {
        ws.send(JSON.stringify(event));
      });
      ws.data.unsubs.push(unsub);
    }
    if (msg.type === "prompt") {
      runtime.orchestrator.send(msg.threadId, {
        type: "prompt",
        content: msg.content,
      });
    }
  },
  close(ws) {
    for (const unsub of ws.data.unsubs) unsub();
  },
}
```

**API route handlers** get the runtime in their context. This is how agent-authored webhooks trigger work:

```ts
// Server internals — inject runtime into handler context
return handler(req, { params, query, runtime });

// routes/webhook-github.ts (user or agent-authored)
export async function POST(req: Request, ctx: RouteContext) {
  const payload = await req.json();
  ctx.runtime.eventBus.emit({
    target: "some-thread-id",
    payload: { type: "github-push", data: payload },
  });
  return new Response("ok");
}
```

### Transports

Each transport file in `transports/` exports a `start(runtime)` function. At boot, the framework scans the directory and calls each one:

```ts
async function bootTransports(projectDir: string, runtime: GuppyRuntime) {
  const glob = new Bun.Glob("*.ts");
  for await (const file of glob.scan(`${projectDir}/transports`)) {
    const mod = await import(`${projectDir}/transports/${file}`);
    await mod.start(runtime);
  }
}
```

A transport wires itself up by calling `send()` on inbound and `subscribe()` for outbound:

```ts
// transports/slack.ts
export async function start(runtime: GuppyRuntime) {
  const client = new SlackClient(process.env.SLACK_TOKEN);

  // Inbound: Slack message → orchestrator
  client.on("message", (msg) => {
    const threadId = runtime.orchestrator.getOrCreateThread("slack", msg.channel);
    runtime.orchestrator.send(threadId, { type: "prompt", content: msg.text });
  });

  // Outbound: subscribe to slack threads → post responses back
  // (subscription mechanism for transport-wide listening TBD)
}
```

### Event Bus

The event bus holds references to the db and orchestrator from construction. It has two roles:

**Immediate events** — pass straight through to the orchestrator:

```ts
emit(event) {
  this.orchestrator.send(event.target, { type: "event", payload: event.payload });
}
```

**Scheduled/cron events** — persisted to SQLite, delivered by a polling scheduler:

```ts
startScheduler() {
  setInterval(() => {
    const due = this.getDueEvents();  // scheduled_at <= now AND status = pending
    for (const event of due) {
      this.orchestrator.send(event.target_thread_id, {
        type: "event",
        payload: event.payload,
      });
      this.markDelivered(event.id);
    }
  }, 1000);
}
```

## Process Diagram

```
┌──────────────────────────────────────────────────────┐
│                    Bun Process                        │
│                                                       │
│  ┌──────────┐                                         │
│  │  SQLite  │◄──────────────────────────────┐         │
│  └────┬─────┘                               │         │
│       │                                     │         │
│  ┌────▼─────────────────────────────────┐   │         │
│  │           Orchestrator               │   │         │
│  │                                      │   │         │
│  │  threads: Map<id, AgentThread>       │   │         │
│  │  subscribers: Map<id, Set<callback>> │   │         │
│  │                                      │   │         │
│  │  .send(threadId, msg)                │   │         │
│  │  .subscribe(threadId, cb) → unsub    │   │         │
│  │  .getOrCreateThread(transport, ch)   │   │         │
│  └──┬──────────────┬───────────────┬────┘   │         │
│     │              │               │        │         │
│     ▼              ▼               ▼        │         │
│  AgentThread    AgentThread    AgentThread   │         │
│  (mailbox,      (mailbox,      (mailbox,    │         │
│   agentLoop)     agentLoop)     agentLoop)  │         │
│                                             │         │
│  ┌───────────┐  ┌────────────────────────┐  │         │
│  │ Event Bus │  │     Bun.serve()        │  │         │
│  │           │  │                        │  │         │
│  │ scheduler─┤──┤  HTTP: shell, API,     │──┘         │
│  │ emit()    │  │        route handlers  │            │
│  │ schedule()│  │  WS:   subscribe,      │            │
│  └───────────┘  │        prompt, steer   │            │
│                 └────────────────────────┘            │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐         │
│  │ transport/│  │ transport/│  │ transport/│          │
│  │  slack.ts │  │ discord.ts│  │  email.ts │          │
│  └───────────┘  └───────────┘  └───────────┘         │
│                                                       │
│  All boxes hold a reference to runtime =              │
│  { db, orchestrator, eventBus }                       │
└──────────────────────────────────────────────────────┘
```

## Why This Works

**One shared object passed everywhere.** No framework magic, no dependency injection container. The runtime is a plain object created at boot and closed over by each component.

**Orchestrator has no knowledge of transports.** It accepts messages via `send()` and fans out events via `subscribe()`. It doesn't know if a message came from Slack, a WebSocket, or a cron job.

**Same mechanism for all sources.** A WebSocket prompt, a Slack message, an event bus trigger, and a webhook all produce a `MailboxMessage` sent to `orchestrator.send()`. By the time they reach a thread, they're indistinguishable.

**Web server is just another transport** that happens to also serve HTML. The WebSocket handlers follow the same pattern as any other transport: call `send()` for inbound, call `subscribe()` for outbound.

**Route handlers get the runtime in context.** An agent-authored webhook endpoint can trigger any thread, schedule events, or query the database — same power as a transport.

**`boot()` is trivial.** Open db, create orchestrator, create event bus, start everything. The wiring is a straight dependency chain that fans out at the end.

## Open Questions

- **Transport-wide subscription**: A Slack transport needs to subscribe to all slack-originated threads, not one at a time. Does the orchestrator support wildcard subscriptions (e.g., subscribe by transport name), or does the transport subscribe per-thread as they're created?
- **Outbound response shape**: What does a transport receive when a thread finishes? The full event stream (text deltas, tool calls, etc.)? Or just the final response text? Transports like Slack probably only want the final message, while the web UI wants the full stream.
- **Thread creation hook**: When the orchestrator creates a new thread, transports may need to know (e.g., Slack transport needs to subscribe to the new thread's events). An `onThreadCreated` callback? Or does the transport poll?
- **Graceful shutdown**: On `SIGTERM`, the runtime needs to drain active agent loops, close transport connections, and flush the event bus. What's the shutdown order?
- **Error isolation**: If a transport's `start()` throws, should it prevent boot? Or log and continue with degraded operation?
