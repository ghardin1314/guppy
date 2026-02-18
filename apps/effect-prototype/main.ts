/**
 * Effect runtime prototype.
 *
 * Validates:
 *  1. ManagedRuntime owned by a wrapper class
 *  2. Registering any Effect service that depends on core services
 *  3. Generic tracking of registered services (Extra)
 *  4. Plain public methods that delegate through the runtime
 *  5. Finalizer ordering on shutdown
 *  6. Callback → Queue bridge for external SDK emitters
 */

import { Context, Effect, Layer, ManagedRuntime, Queue, Ref } from "effect";

// ---------------------------------------------------------------------------
// 1. Core service tags
// ---------------------------------------------------------------------------

class Database extends Context.Tag("Database")<
  Database,
  {
    get(key: string): Effect.Effect<string | undefined>;
    set(key: string, value: string): Effect.Effect<void>;
  }
>() {}

class Orchestrator extends Context.Tag("Orchestrator")<
  Orchestrator,
  {
    send(threadId: string, content: string): Effect.Effect<void>;
    getMessages(threadId: string): Effect.Effect<string[]>;
  }
>() {}

class EventBus extends Context.Tag("EventBus")<
  EventBus,
  {
    emit(target: string, payload: string): Effect.Effect<void>;
  }
>() {}

type CoreServices = Database | Orchestrator | EventBus;

// ---------------------------------------------------------------------------
// 2. Core service layers
// ---------------------------------------------------------------------------

const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const store = yield* Ref.make(new Map<string, string>());

    console.log("[boot] Database opened");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => console.log("[shutdown] Database closed"))
    );

    return {
      get: (key: string) => Ref.get(store).pipe(Effect.map((m) => m.get(key))),
      set: (key: string, value: string) =>
        Ref.update(store, (m) => new Map(m).set(key, value)),
    };
  })
);

const OrchestratorLive = Layer.scoped(
  Orchestrator,
  Effect.gen(function* () {
    const db = yield* Database;
    const threads = yield* Ref.make(new Map<string, string[]>());

    console.log("[boot] Orchestrator started");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => console.log("[shutdown] Orchestrator stopped"))
    );

    return {
      send: (threadId: string, content: string) =>
        Effect.gen(function* () {
          yield* Ref.update(threads, (m) => {
            const msgs = m.get(threadId) ?? [];
            return new Map(m).set(threadId, [...msgs, content]);
          });
          yield* db.set(`last:${threadId}`, content);
        }),
      getMessages: (threadId: string) =>
        Ref.get(threads).pipe(Effect.map((m) => m.get(threadId) ?? [])),
    };
  })
);

const EventBusLive = Layer.scoped(
  EventBus,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;

    console.log("[boot] EventBus started");
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => console.log("[shutdown] EventBus stopped"))
    );

    return {
      emit: (target: string, payload: string) =>
        orchestrator.send(target, `[event] ${payload}`),
    };
  })
);

const CoreLive = Layer.mergeAll(DatabaseLive, OrchestratorLive, EventBusLive).pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(OrchestratorLive),
  Layer.provide(DatabaseLive),
);

// ---------------------------------------------------------------------------
// 3. Transports — real Effect services with unique tags
// ---------------------------------------------------------------------------

class SlackService extends Context.Tag("SlackService")<
  SlackService,
  {
    postMessage(channel: string, text: string): Effect.Effect<void>;
  }
>() {}

class DiscordService extends Context.Tag("DiscordService")<
  DiscordService,
  {
    sendMessage(channel: string, text: string): Effect.Effect<void>;
  }
>() {}

class SlackTransport {
  readonly layer;

  constructor(config: { token: string; intervalMs?: number }) {
    const name = "slack";
    const intervalMs = config.intervalMs ?? 500;

    this.layer = Layer.scoped(
      SlackService,
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const queue = yield* Queue.unbounded<string>();

        const interval = setInterval(() => {
          Queue.unsafeOffer(queue, `tick from ${name}`);
        }, intervalMs);

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const msg = yield* Queue.take(queue);
              yield* orchestrator.send(name, msg);
            })
          )
        );

        console.log(`[boot] Transport '${name}' connected`);

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearInterval(interval);
            console.log(`[shutdown] Transport '${name}' disconnected`);
          })
        );

        return {
          postMessage: (channel: string, text: string) =>
            orchestrator.send(channel, `[slack → ${channel}] ${text}`),
        };
      })
    );
  }
}

class DiscordTransport {
  readonly layer;

  constructor(config: { token: string; intervalMs?: number }) {
    const name = "discord";
    const intervalMs = config.intervalMs ?? 700;

    this.layer = Layer.scoped(
      DiscordService,
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const queue = yield* Queue.unbounded<string>();

        const interval = setInterval(() => {
          Queue.unsafeOffer(queue, `tick from ${name}`);
        }, intervalMs);

        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const msg = yield* Queue.take(queue);
              yield* orchestrator.send(name, msg);
            })
          )
        );

        console.log(`[boot] Transport '${name}' connected`);

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearInterval(interval);
            console.log(`[shutdown] Transport '${name}' disconnected`);
          })
        );

        return {
          sendMessage: (channel: string, text: string) =>
            orchestrator.send(channel, `[discord → ${channel}] ${text}`),
        };
      })
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Guppy class — owns the runtime, exposes plain API
// ---------------------------------------------------------------------------

// Extra tracks services registered beyond CoreServices.
// The accumulated layer carries Extra in its output slot, so the generic
// flows through register → boot → runtime naturally with no casts.
class Guppy<Extra = never> {
  private constructor(
    private accumulated: Layer.Layer<Extra, never, CoreServices>,
    private managedRuntime?: ManagedRuntime.ManagedRuntime<CoreServices | Extra, never>,
  ) {}

  static create(): Guppy {
    return new Guppy(Layer.empty);
  }

  // T inferred from service.layer's output tag.
  // Layer.merge unions output types: Layer<Extra | T, never, CoreServices>.
  // new Guppy(merged) infers Guppy<Extra | T> from the constructor parameter.
  register<T>(service: {
    readonly layer: Layer.Layer<T, never, CoreServices>;
  }): Guppy<Extra | T> {
    return new Guppy(Layer.merge(this.accumulated, service.layer));
  }

  async boot(): Promise<void> {
    // Provide CoreLive to satisfy accumulated layer's deps, then merge with
    // CoreLive so the runtime provides both core + registered services.
    const provided = Layer.provide(this.accumulated, CoreLive);
    const main = Layer.merge(CoreLive, provided);

    this.managedRuntime = ManagedRuntime.make(main);
    await this.managedRuntime.runPromise(Effect.void);
    console.log("[boot] Guppy ready\n");
  }

  // -- Plain public API --

  send(threadId: string, content: string): void {
    this.managedRuntime!.runFork(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        yield* orchestrator.send(threadId, content);
      })
    );
  }

  async getMessages(threadId: string): Promise<string[]> {
    return this.managedRuntime!.runPromise(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        return yield* orchestrator.getMessages(threadId);
      })
    );
  }

  emit(target: string, payload: string): void {
    this.managedRuntime!.runFork(
      Effect.gen(function* () {
        const eventBus = yield* EventBus;
        yield* eventBus.emit(target, payload);
      })
    );
  }

  // Run an arbitrary effect against the runtime.
  // Accepts effects requiring CoreServices, registered services, or both.
  run<A>(effect: Effect.Effect<A, never, CoreServices | Extra>): Promise<A> {
    return this.managedRuntime!.runPromise(effect);
  }

  async shutdown(): Promise<void> {
    console.log("\n[shutdown] Shutting down...");
    await this.managedRuntime!.dispose();
    console.log("[shutdown] Done");
  }
}

// ---------------------------------------------------------------------------
// 5. Test it
// ---------------------------------------------------------------------------

const guppy = Guppy.create()
  .register(new SlackTransport({ token: "xoxb-fake", intervalMs: 400 }))
  .register(new DiscordTransport({ token: "discord-fake", intervalMs: 600 }));

// Type: Guppy<SlackService | DiscordService>

await guppy.boot();

// Plain calls from outside Effect
guppy.send("thread-1", "hello from the web UI");
guppy.send("thread-1", "another message");
guppy.emit("thread-2", "webhook payload");

// Use a registered service directly via run() — type-safe!
// Only works because SlackService is in Extra.
await guppy.run(
  Effect.gen(function* () {
    const slack = yield* SlackService;
    yield* slack.postMessage("#general", "hello from run()");
  })
);

// Let transport ticks accumulate
await Bun.sleep(1500);

const t1 = await guppy.getMessages("thread-1");
const t2 = await guppy.getMessages("thread-2");
const slack = await guppy.getMessages("slack");
const discord = await guppy.getMessages("discord");
const general = await guppy.getMessages("#general");

console.log("thread-1:", t1);
console.log("thread-2:", t2);
console.log("slack ticks:", slack);
console.log("discord ticks:", discord);
console.log("#general:", general);

// -- Type safety test: unregistered service should fail at compile time --

class TelegramService extends Context.Tag("TelegramService")<
  TelegramService,
  { send(chat: string, text: string): Effect.Effect<void> }
>() {}

try {
  await guppy.run(
    // @ts-expect-error — TelegramService is not in CoreServices | SlackService | DiscordService
    Effect.gen(function* () {
      const telegram = yield* TelegramService;
      yield* telegram.send("chat-1", "this should not compile");
    })
  );
} catch {
  console.log("[expected] TelegramService not found — compile-time + runtime guard works");
}

await guppy.shutdown();
