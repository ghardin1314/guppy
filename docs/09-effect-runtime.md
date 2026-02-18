# Effect Runtime

Uses [Effect](https://effect.website) for dependency injection, structured concurrency, and lifecycle management. The public API is plain TypeScript — Effect is an implementation detail hidden behind the `Guppy` class.

Prototype: `apps/effect-prototype/main.ts`

## The Guppy Class

Single object that owns the Effect `ManagedRuntime` and exposes plain methods. Everything outside the class — `start.ts`, Bun.serve, route handlers — sees only plain TypeScript.

`Extra` tracks services registered beyond `CoreServices`. The accumulated layer carries `Extra` in its output slot, so the type flows through `register` → `boot` → `runtime` naturally — no casts.

```ts
class Guppy<Extra = never> {
  private constructor(
    private accumulated: Layer.Layer<Extra, never, CoreServices>,
    private managedRuntime?: ManagedRuntime.ManagedRuntime<CoreServices | Extra, never>,
  ) {}

  static create(): Guppy {
    return new Guppy(Layer.empty);
  }

  register<T>(service: {
    readonly layer: Layer.Layer<T, never, CoreServices>;
  }): Guppy<Extra | T> {
    return new Guppy(Layer.merge(this.accumulated, service.layer));
  }

  async boot(): Promise<void> {
    const provided = Layer.provide(this.accumulated, CoreLive);
    const main = Layer.merge(CoreLive, provided);
    this.managedRuntime = ManagedRuntime.make(main);
    await this.managedRuntime.runPromise(Effect.void);
  }

  send(threadId: string, msg: MailboxMessage): void {
    this.managedRuntime!.runFork(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator;
        yield* orchestrator.send(threadId, msg);
      })
    );
  }

  subscribe(threadId: string, callback: (event: AgentEvent) => void): () => void {
    // Synchronous — returns unsub immediately, delegates to orchestrator
    let unsub: (() => void) | undefined;
    this.managedRuntime!.runFork(
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator;
        unsub = yield* orchestrator.subscribe(threadId, callback);
      })
    );
    return () => unsub?.();
  }

  emit(target: string, payload: unknown): void {
    this.managedRuntime!.runFork(
      Effect.gen(function*() {
        const eventBus = yield* EventBus;
        yield* eventBus.emit(target, payload);
      })
    );
  }

  run<A>(effect: Effect.Effect<A, never, CoreServices | Extra>): Promise<A> {
    return this.managedRuntime!.runPromise(effect);
  }

  async shutdown(): Promise<void> {
    await this.managedRuntime?.dispose();
  }
}
```

### Why a Private Constructor

The constructor takes `Layer<Extra, never, CoreServices>`. When `Extra = never`, `Layer.empty` (`Layer<never, never, never>`) is assignable via covariance on `RIn` (`never extends CoreServices`). But for generic `Extra`, the compiler can't verify `Layer.empty` matches `Layer<Extra, ...>` — contravariance on `ROut` requires `Extra extends never`. So `create()` handles the `Extra = never` case and `register()` handles widening via `new Guppy(merged)` where the type is inferred from the layer.

### Type Flow Through register

```
register<T>(service) →
  Layer.merge(this.accumulated, service.layer)
    Layer<Extra, never, CoreServices>  +  Layer<T, never, CoreServices>
    = Layer<Extra | T, never, CoreServices>
  →
  new Guppy(merged)
    TypeScript infers Guppy<Extra | T> from the constructor parameter
```

Each `register` returns a new `Guppy` with the widened generic. No casts — Layer.merge unions the output types and the constructor infers the rest.

```
Guppy.create()                 → Guppy<never>
  .register(slackTransport)    → Guppy<SlackService>
  .register(discordTransport)  → Guppy<SlackService | DiscordService>
```

### Type Safety on run()

`run()` accepts `Effect<A, never, CoreServices | Extra>`. An effect requiring an unregistered service won't compile:

```ts
// ✓ SlackService was registered
guppy.run(Effect.gen(function*() {
  const slack = yield* SlackService;
  yield* slack.postMessage("#general", "hello");
}));

// ✗ TelegramService was NOT registered — compile error
guppy.run(Effect.gen(function*() {
  const telegram = yield* TelegramService;  // ← type error
}));
```

Effect also catches this at runtime: `Service not found: TelegramService`.

## Entry Point

```ts
// project/start.ts
import { Guppy, createServer } from "guppy";
import { SlackTransport } from "@guppy/transports/slack";
import { DiscordTransport } from "@guppy/transports/discord";
import shell from "./shell.html";

const guppy = Guppy.create()
  .register(new SlackTransport({ token: process.env.SLACK_TOKEN }))
  .register(new DiscordTransport({ token: process.env.DISCORD_TOKEN }));

await guppy.boot();
await createServer(guppy, shell);
```

No Effect types visible. Someone with zero Effect knowledge can read, understand, and modify this.

## Boot Sequence

```
Guppy.create()                  Layer.empty
  ↓
.register(transport)             Layer.merge(accumulated, transport.layer)
.register(transport)             (repeat)
  ↓
.boot()
  ↓
  Layer.provide(accumulated, CoreLive)   → satisfy transport deps
  Layer.merge(CoreLive, provided)        → combine core + transports
  ↓
  ManagedRuntime.make(main)
    → Effect resolves dependency graph
    → Constructs services in order (DB → orchestrator → event bus → transports)
    → Transports connect, start listening
  ↓
  Ready — Guppy.send/run/emit available
  ↓
createServer(guppy, shell)
  → Bun.serve starts, receives guppy for context
```

Shutdown runs in reverse: transports disconnect → event bus stops → orchestrator drains → database closes. All automatic via `Layer.addFinalizer`.

## Inside vs Outside the Boundary

```
┌─────────────────────────────────────────────────┐
│                   Effect                         │
│                                                  │
│  Orchestrator    EventBus    Transports           │
│  (Queues,        (Schedule,  (Layer.scoped,       │
│   Fibers)         Effects)    finalizers)         │
│                                                  │
├──────────────────────────────────────────────────┤
│                 Guppy class                      │
│         (ManagedRuntime.runFork/runPromise)       │
├──────────────────────────────────────────────────┤
│                  Plain TS                         │
│                                                  │
│  start.ts    Bun.serve    Route handlers          │
│  Transports  WebSocket    Agent-authored          │
│  (config)    callbacks    pages                   │
└─────────────────────────────────────────────────┘
```

**Inside Effect** (top zone): Orchestrator, EventBus, and transport service implementations use Effect primitives — Queues, Fibers, Layers, Refs. This is where concurrency, lifecycle, and DI live.

**The Guppy class** (middle): The membrane. Translates between plain TS calls (`send`, `subscribe`, `emit`) and Effect operations (`runFork`, `runPromise`). Nothing above or below this line touches Effect types.

**Plain TS** (bottom zone): Everything user-facing — `start.ts`, Bun.serve, route handlers, WebSocket callbacks, transport config classes. Zero Effect imports. This is what users read, write, and modify.

## Transports as Real Services

Each transport is a regular Effect service with a unique `Context.Tag`. The tag defines an interface for interacting with the transport (sending messages back to the platform). The layer handles lifecycle (connect, consume inbound, finalizer to disconnect).

```ts
// Tag defines the service interface
class SlackService extends Context.Tag("SlackService")<
  SlackService,
  {
    postMessage(channel: string, text: string): Effect.Effect<void>;
  }
>() {}

// Transport class holds config, exposes the layer
export class SlackTransport {
  readonly layer;

  constructor(config: { token: string }) {
    this.layer = Layer.scoped(
      SlackService,
      Effect.gen(function*() {
        const orchestrator = yield* Orchestrator;
        const inbound = yield* Queue.unbounded<SlackMessage>();
        const client = new SlackClient(config.token);

        // Callback → Effect bridge via Queue
        client.on("message", (msg) => {
          Queue.unsafeOffer(inbound, msg);
        });

        // Fiber consumes queue, routes to orchestrator
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function*() {
              const msg = yield* Queue.take(inbound);
              const threadId = yield* orchestrator.getOrCreateThread(
                "slack", msg.channel
              );
              yield* orchestrator.send(threadId, {
                type: "prompt",
                content: msg.text,
              });
            })
          )
        );

        yield* Effect.addFinalizer(() =>
          Effect.promise(() => client.disconnect())
        );

        return {
          postMessage: (channel, text) =>
            orchestrator.send(channel, `[slack] ${text}`),
        };
      })
    );
  }
}
```

### Callback Bridge Pattern

External SDKs (Slack, Discord) use event emitters. Inside a `Layer.scoped`, the pattern is:

1. Create an unbounded `Queue`
2. In the event callback, `Queue.unsafeOffer` (sync, no Effect context needed)
3. `Effect.forkScoped` a fiber that loops on `Queue.take` → processes in Effect context

`forkScoped` ties the fiber's lifetime to the layer's scope (the ManagedRuntime). `Effect.fork` alone won't work — the fiber gets interrupted when the layer construction effect completes.

### Package Structure

Transport packages are published as `@guppy/transports/<name>`. Package authors write Effect. Users install and register without touching Effect:

```
bun add @guppy/transports/slack
```

```ts
import { SlackTransport } from "@guppy/transports/slack";
guppy.register(new SlackTransport({ token: process.env.SLACK_TOKEN }));
```

### Webhook Routes

Some transports need HTTP endpoints (Discord interaction verification, Slack event subscriptions). These are scaffolded by the CLI as plain route handlers:

```ts
// routes/discord-interactions.ts (scaffolded by CLI)
export async function POST(req: Request, ctx: RouteContext) {
  const payload = await req.json();

  if (!verifyDiscordSignature(req, payload)) {
    return new Response("Unauthorized", { status: 401 });
  }

  ctx.guppy.emit(payload.channel_id, {
    type: "discord-interaction",
    data: payload,
  });

  return new Response("ok");
}
```

Plain code. No Effect. The route receives the Guppy instance in context and calls `guppy.emit()`.

## Web Server

Bun.serve stays outside the Guppy class. It receives the Guppy instance and uses its plain API.

```ts
// Inside createServer(guppy, shell)
Bun.serve({
  routes: {
    "/api/*": (req) => handleAPI(req, { guppy }),
    "/*": shell,
  },

  websocket: {
    open(ws) {
      ws.data = { unsubs: [] };
    },

    message(ws, raw) {
      const msg = JSON.parse(String(raw));

      switch (msg.type) {
        case "subscribe": {
          const unsub = guppy.subscribe(msg.threadId, (event) => {
            ws.send(JSON.stringify(event));
          });
          ws.data.unsubs.push(unsub);
          break;
        }
        case "prompt": {
          guppy.send(msg.threadId, {
            type: "prompt",
            content: msg.content,
          });
          break;
        }
        case "steer": {
          guppy.send(msg.threadId, {
            type: "steering",
            content: msg.content,
          });
          break;
        }
        case "stop": {
          guppy.send(msg.threadId, { type: "stop" });
          break;
        }
      }
    },

    close(ws) {
      for (const unsub of ws.data.unsubs) unsub();
    },
  },
});
```

## Core Services as Layers

### Database

```ts
const DatabaseLive = (projectDir: string) =>
  Layer.scoped(
    Database,
    Effect.acquireRelease(
      Effect.sync(() => openDatabase(`${projectDir}/guppy.db`)),
      (db) => Effect.sync(() => db.close())
    )
  );
```

### Orchestrator

```ts
const OrchestratorLive = Layer.scoped(
  Orchestrator,
  Effect.gen(function*() {
    const db = yield* Database;
    const threads = yield* Ref.make(new Map<string, AgentThread>());
    const subscribers = yield* Ref.make(new Map<string, Set<(event: AgentEvent) => void>>());
    // ... Queue per thread, Fiber per active run

    yield* Effect.addFinalizer(() =>
      // Drain active threads, interrupt fibers
    );

    return { send, subscribe, getOrCreateThread };
  })
);
```

### Event Bus

```ts
const EventBusLive = Layer.scoped(
  EventBus,
  Effect.gen(function*() {
    const orchestrator = yield* Orchestrator;

    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.gen(function*() {
          const due = getDueEvents(db);
          for (const event of due) {
            yield* orchestrator.send(event.target_thread_id, {
              type: "event",
              payload: event.payload,
            });
            markDelivered(db, event.id);
          }
        }),
        Schedule.spaced("1 second")
      )
    );

    yield* Effect.addFinalizer(() =>
      // Stop scheduler, flush pending
    );

    return { emit, schedule, cancel };
  })
);
```

## Layer Composition

Core layers have inter-dependencies (Orchestrator needs Database, EventBus needs Orchestrator). Compose with `Layer.mergeAll` + `Layer.provide`:

```ts
const CoreLive = Layer.mergeAll(DatabaseLive, OrchestratorLive, EventBusLive).pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(OrchestratorLive),
  Layer.provide(DatabaseLive),
);
```

Registered service layers declare their dependencies via `CoreServices` in the `RIn` position. At boot, `Layer.provide(accumulated, CoreLive)` satisfies those deps. Effect deduplicates — each service is constructed once regardless of how many layers depend on it.

```
DatabaseLive
    ↓
OrchestratorLive  (yield* Database)
    ↓
EventBusLive  (yield* Orchestrator)
    ↓
┌───┴────────────────────────┐
SlackService                  DiscordService
(yield* Orchestrator)         (yield* Orchestrator)
```

Shutdown runs in reverse order. All automatic via Layer finalizers.

## CLI Scaffolding

`guppy transport add <name>` automates the mechanical wiring:

1. `bun add @guppy/transports/<name>`
2. Adds import + `.register()` to `start.ts`
3. Scaffolds webhook route to `routes/` if the transport needs one
4. Prompts for credentials, writes to `.env`

Example — `guppy transport add discord`:

```diff
 // project/start.ts
 import { Guppy, createServer } from "guppy";
 import { SlackTransport } from "@guppy/transports/slack";
+import { DiscordTransport } from "@guppy/transports/discord";
 import shell from "./shell.html";

 const guppy = Guppy.create()
   .register(new SlackTransport({ token: process.env.SLACK_TOKEN }))
+  .register(new DiscordTransport({ token: process.env.DISCORD_TOKEN }));

 await guppy.boot();
 await createServer(guppy, shell);
```

```diff
 # .env
 SLACK_TOKEN=xoxb-...
+DISCORD_TOKEN=...
```

If the transport needs a webhook (e.g. Discord interactions verification), the CLI also scaffolds a route handler:

```
Created routes/discord-interactions.ts
```

## What Effect Provides

| Concern | Effect primitive | What it replaces |
|---|---|---|
| Boot/shutdown ordering | `Layer` composition + finalizers | Manual init/teardown sequencing |
| Dependency injection | `Layer.provide`, `yield*` | Passing runtime object through constructors |
| Thread mailboxes | `Queue.bounded` | Array + async notify loop |
| Parallel thread runs | `Fiber.fork` + auto-interrupt | Promise.all + AbortController trees |
| Event bus scheduling | `Schedule.spaced` + `Effect.repeat` | setInterval |
| Transport lifecycle | `Layer.scoped` + `Effect.forkScoped` | Manual connect/disconnect tracking |
| Graceful shutdown | `ManagedRuntime.dispose()` | Reverse-order teardown code |
| Service type safety | Generic tracking on `Guppy<Extra>` | Runtime-only "service not found" errors |

## Prototype Findings

Validated in `apps/effect-prototype/main.ts`:

1. **`Effect.forkScoped`, not `Effect.fork`** — Inside `Layer.scoped`, a forked fiber must be tied to the layer's scope. `Effect.fork` creates a fiber that gets interrupted when the layer construction effect returns. `Effect.forkScoped` ties it to the ManagedRuntime's lifetime.

2. **Unique `Context.Tag` per service** — Effect deduplicates layers by tag identity. Two services sharing a tag means only one gets constructed. Each transport/service needs its own `Context.Tag` subclass with a unique string identifier.

3. **Layer variance drives the API** — `Layer<in ROut, out E, out RIn>`. Contravariance on `ROut` means `Layer<T>` is assignable to `Layer<never>` (since `never extends T`), and `Layer<A | B>` is assignable to `Layer<A>` (since `A extends A | B`). Covariance on `RIn` means a layer requiring `Orchestrator` is assignable where `CoreServices` is expected (since `Orchestrator extends Database | Orchestrator | EventBus`). This makes `register`, `boot`, and `run` all type-check without casts.

4. **`ManagedRuntime` takes two type params** — `ManagedRuntime<R, ER>` where `R` is the provided services and `ER` is the layer construction error type. Not just `ManagedRuntime<R>`.

5. **`ManagedRuntime.make` constructs lazily** — Layers are constructed on the first `runPromise`/`runFork` call, not on `make`. The `await runtime.runPromise(Effect.void)` in `boot()` forces eager construction.

6. **Callback → Queue bridge works** — `Queue.unsafeOffer` from a `setInterval` callback successfully enqueues items. A `forkScoped` fiber consuming via `Queue.take` picks them up and routes through the orchestrator. This validates the pattern for real SDK event emitters.

## Open Questions

- **Effect version**: Effect moves fast. Pin to a specific version? Track latest?
- **Error channel**: Effect's typed errors (`Effect<A, E, R>`) could model transport connection failures, LLM API errors, etc. How much do we invest in typed error handling vs letting things crash?
- **Testing**: Effect services are trivially mockable via `Layer.succeed(Orchestrator, mockImpl)`. Define the testing strategy early.
- **Transport outbound subscriptions**: How does a transport subscribe to responses for threads it created? Per-thread subscription from inside the Layer? A filtered stream from the orchestrator?
