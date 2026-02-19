# Transports v2

Supersedes [05-transports.md](./05-transports.md) and the transport sections of [08-runtime.md](./08-runtime.md) and [09-effect-runtime.md](./09-effect-runtime.md).

## Overview

Transports bridge external messaging channels (Slack, Discord, email, web UI) into the Guppy runtime. Every transport implements the same small interface and is registered dynamically at boot via a `LayerMap`-backed registry. Agent threads pull their transport via Effect's DI — no pub/sub, no subscriber maps, no fan-out.

## Transport Interface

Two methods. Transports decide their own delivery semantics internally.

```ts
interface Transport {
  /** Called by the agent thread at the start of each turn.
   *  Returns channel-specific context: system prompt additions,
   *  recent channel messages, formatting instructions, etc. */
  readonly getContext: (threadId: string) => Effect.Effect<string>;

  /** Called by the agent thread for every AgentEvent.
   *  The transport decides what to do with each event type —
   *  Slack might post on agent_end only, web UI streams everything. */
  readonly deliver: (threadId: string, event: AgentEvent) => Effect.Effect<void>;
}
```

`getContext` serves double duty: transport-specific system prompting AND recent channel message context. The transport fetches from its platform's API (Slack history, Discord messages, etc.) and formats it. No separate channel history store needed — defer to the platform's own history.

`deliver` receives the full `AgentEvent` stream. Each transport filters for what it cares about. A Slack transport ignores `text_delta` and posts the final message on `agent_end`. A web transport forwards everything over WebSocket. Formatting (Slack blocks, Discord embeds, email HTML) lives inside `deliver` — the transport is the only thing that understands its platform's format.

## Effect Services

Three services wire transports into the DI graph:

```ts
// The interface — provided into agent thread context
class TransportService extends Context.Tag("@guppy/core/TransportService")<
  TransportService,
  Transport
>() {}

// Backing store — transports register here during Layer construction
class TransportRegistry extends Context.Tag("@guppy/core/TransportRegistry")<
  TransportRegistry,
  {
    readonly register: (name: string, transport: Transport) => Effect.Effect<void>;
    readonly lookup: (name: string) => Effect.Effect<Transport>;
  }
>() {}

// LayerMap — agent threads access transports via get(name) → Layer<TransportService>
class TransportMap extends LayerMap.Service<TransportMap>()(
  "@guppy/core/TransportMap",
  {
    lookup: (name: string) =>
      Layer.effect(
        TransportService,
        Effect.gen(function*() {
          const registry = yield* TransportRegistry;
          return yield* registry.lookup(name);
        }),
      ),
    dependencies: [TransportRegistryLive],
  },
) {}
```

`TransportRegistry` holds a `Ref<HashMap<string, Transport>>`. Transports write to it during boot. `TransportMap` reads from it lazily when threads are spawned.

## Layer Graph

```
TransportRegistryLive          (no deps, constructed first)
  ↑               ↑
TransportMap    SlackTransportLive    DiscordTransportLive
  ↑               ↓                    ↓
OrchestratorLive ←────────────────────┘
```

No circular dependency. Transports depend on both `TransportRegistry` (to register) and `Orchestrator` (to send inbound messages). The orchestrator depends on `TransportMap` (to provide transports to threads). This is a diamond on `TransportRegistry`, not a cycle.

Construction order:

1. **TransportRegistryLive** — empty map
2. **TransportMap** — LayerMap created, no lookups yet (lazy)
3. **OrchestratorLive** — captures TransportMap handle
4. **SlackTransportLive, DiscordTransportLive, etc.** — register with TransportRegistry, capture Orchestrator, start inbound fibers

Lookups happen at thread spawn time, after all transports have registered.

## Inbound Flow (platform → agent)

Each transport starts a scoped fiber during Layer construction that consumes platform messages and routes them to the orchestrator:

```ts
const SlackTransportLive = Layer.scoped(
  SlackService,
  Effect.gen(function*() {
    const registry = yield* TransportRegistry;
    const orchestrator = yield* Orchestrator;
    const client = new SlackClient(token);

    // Register transport interface
    yield* registry.register("slack", {
      getContext: (threadId) =>
        Effect.gen(function*() {
          // Fetch recent Slack channel messages via client
          // Format as context string
          return "## Channel: #general\n- Alice: ...\n- Bob: ...";
        }),
      deliver: (threadId, event) =>
        Effect.gen(function*() {
          if (event.type === "agent_end") {
            // Extract final text, post to Slack
          }
        }),
    });

    // Inbound fiber: Slack messages → orchestrator
    const inbound = yield* Queue.unbounded<SlackMessage>();
    client.on("message", (msg) => Queue.unsafeOffer(inbound, msg));

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function*() {
          const msg = yield* Queue.take(inbound);
          const threadId = yield* orchestrator.getOrCreateThread("slack", msg.channel);
          yield* orchestrator.send(threadId, ThreadMessage.Prompt({ content: msg.text }));
        }),
      ),
    );

    yield* Effect.addFinalizer(() =>
      Effect.promise(() => client.disconnect())
    );
  }),
);
```

The inbound fiber uses the callback → Queue bridge pattern: `Queue.unsafeOffer` from the SDK's event callback, `Queue.take` in a scoped fiber.

## Thread Integration

When the orchestrator spawns an agent thread, it provides the transport via `LayerMap`:

```ts
yield* spawnThread(threadId, config).pipe(
  Effect.provide(TransportMap.get(transportName)),
);
```

Inside the agent thread, both directions are direct method calls on the provided service:

```ts
const transport = yield* TransportService;

// Before each LLM turn — pull context
const ctx = yield* transport.getContext(threadId);
const enriched = ctx ? `${ctx}\n\n---\n${content}` : content;
yield* agent.prompt(enriched);

// Event delivery — fiber lives for the thread's lifetime
yield* agent.events.pipe(
  Stream.runForEach((event) => transport.deliver(threadId, event)),
  Effect.forkScoped,
);
```

The thread owns its own delivery lifecycle. No orchestrator involvement in routing responses.

## Web Transport

The web transport (browser UI via WebSocket) is a transport like any other. It registers as `"web"` and manages multiple WebSocket connections internally.

```ts
yield* registry.register("web", {
  getContext: (threadId) => Effect.succeed(""),  // no extra context needed
  deliver: (threadId, event) =>
    Effect.sync(() => {
      // Fan out to all WS connections subscribed to this thread
      for (const ws of subscribers.get(threadId) ?? []) {
        ws.send(JSON.stringify(event));
      }
    }),
});
```

For viewing other transports' threads in the web UI, the frontend reads from SQLite directly — the message tree has everything. No transport stacking.

## Context Assembly

`getContext` replaces the static layered context model from [04-agent-model.md](./04-agent-model.md). Instead of filesystem-based MEMORY.md layers, the transport dynamically assembles context per turn:

- **Transport-specific instructions** — formatting rules, available commands, platform conventions
- **Recent channel messages** — fetched from the platform's API, giving the agent conversational context beyond its own thread history
- **Channel metadata** — channel name/topic, participant info, thread vs DM

The global system prompt (agent identity, core instructions) remains static on `AgentThreadConfig.systemPrompt`. The transport's `getContext` provides the dynamic, channel-specific layer on top.

## What This Design Resolves

Open questions from [05-transports.md](./05-transports.md):

| Question | Resolution |
|----------|-----------|
| Trigger → Orchestrator interface | Transport calls `orchestrator.send(threadId, ThreadMessage.Prompt(...))` |
| Sync timing | Transport owns sync via `getContext`, called by agent thread before each turn |
| Delivery interface | Agent thread calls `transport.deliver()` directly — no subscriber map |
| Multi-message responses | Transport's `deliver` receives every `AgentEvent` — it decides how to batch/split for the platform |
| Transport-specific tools | TBD — likely passed at thread spawn via `AgentThreadConfig.tools`, merged with global tools |

Open questions from [08-runtime.md](./08-runtime.md):

| Question | Resolution |
|----------|-----------|
| Transport-wide subscription | Not needed — delivery is per-thread via provided `TransportService` |
| Outbound response shape | Full `AgentEvent` stream — transport filters internally |
| Thread creation hook | Not needed — transport creates threads itself via `orchestrator.getOrCreateThread` |

## Open Questions

- **Transport-specific tools**: how are they scoped? Passed via `AgentThreadConfig.tools` at spawn? Or the transport provides them through a method on the `Transport` interface?
- **Channel history persistence**: deferred. Transports use platform APIs for now. If we need offline/cross-restart channel history, add a `ChannelHistoryStore` later.
- **Hot reload**: `TransportMap.invalidate(name)` tears down a transport's cached layer. Full hot-reload story TBD.
- **Error handling in deliver**: if Slack API fails mid-delivery, does the thread retry? Buffer? The transport probably handles this internally.
