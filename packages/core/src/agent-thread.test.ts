import { expect } from "bun:test";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import { makeDbLayer } from "./db.ts";
import { ThreadStore, ThreadStoreLive } from "./repository.ts";
import { spawn } from "./agent-thread.ts";
import { ThreadMessage } from "./thread-message.ts";
import {
  it,
  EchoAgentFactoryLive,
  makeTestTransport,
  makeInstrumentedAgentFactory,
  collectUntilEnd,
  withThread,
  testConfig,
} from "./testing.ts";
import { TransportId, ThreadId } from  "./schema.ts";

// -- Layers -------------------------------------------------------------------

const DbLayer = makeDbLayer(":memory:");
const StoreLayer = Layer.provideMerge(ThreadStoreLive, DbLayer);
const { state: transportState, layer: TransportLayer } = makeTestTransport();
const TestLayer = Layer.mergeAll(StoreLayer, EchoAgentFactoryLive, TransportLayer);

// -- Tests --------------------------------------------------------------------

it.layer(TestLayer)("agent-thread", (it) => {
  it.live("processes a prompt and emits agent_end", () =>
    withThread("t1", (handle) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "hello" }));
        const events = yield* Fiber.join(fiber);

        const types = events.map((e) => e.type);
        expect(types).toContain("turn_end");
        expect(types).toContain("agent_end");
      }),
    ),
  );

  it.live("persists user and assistant messages", () =>
    withThread("t2", (handle, threadId) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "persist me" }));
        yield* Fiber.join(fiber);

        yield* Effect.yieldNow();

        const ctx = yield* store.getContext(threadId);
        expect(ctx.length).toBeGreaterThanOrEqual(2);
        expect(ctx[0]!.content.role).toBe("user");
        expect(ctx[0]!.content).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "persist me" }],
        });
        expect(ctx[1]!.content.role).toBe("assistant");
      }),
    ),
  );

  it.live("processes messages sequentially", () =>
    withThread("t3", (handle, threadId) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;

        const f1 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "first" }));
        yield* Fiber.join(f1);
        yield* Effect.yieldNow();

        const f2 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "second" }));
        yield* Fiber.join(f2);
        yield* Effect.yieldNow();

        const ctx = yield* store.getContext(threadId);
        expect(ctx.length).toBeGreaterThanOrEqual(4);
        expect(ctx[0]!.content.role).toBe("user");
        expect(ctx[1]!.content.role).toBe("assistant");
        expect(ctx[2]!.content.role).toBe("user");
        expect(ctx[3]!.content.role).toBe("assistant");
      }),
    ),
  );

  it.live("stop with no active run returns false", () =>
    withThread("t4", (handle) =>
      Effect.gen(function* () {
        const result = yield* handle.send(ThreadMessage.Stop());
        expect(result).toBe(false);
      }),
    ),
  );

  it.live("context builds across multiple prompts", () =>
    withThread("t5", (handle, threadId) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;

        const f1 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "msg1" }));
        yield* Fiber.join(f1);
        yield* Effect.yieldNow();

        const f2 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "msg2" }));
        yield* Fiber.join(f2);
        yield* Effect.yieldNow();

        const ctx = yield* store.getContext(threadId);
        expect(ctx.length).toBeGreaterThanOrEqual(4);
        expect(ctx[0]!.content).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "msg1" }],
        });
        expect(ctx[2]!.content).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "msg2" }],
        });
      }),
    ),
  );

  it.live("delivers events to transport", () =>
    withThread("t6", (handle) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "deliver me" }));
        yield* Fiber.join(fiber);
        yield* Effect.yieldNow();

        const delivered = transportState.delivered.filter(
          (d) => d.event.type === "turn_end" || d.event.type === "agent_end",
        );
        expect(delivered.length).toBeGreaterThanOrEqual(2);
      }),
    ),
  );

  it.live("calls transport.getContext before prompt", () =>
    withThread("t7", (handle, threadId) =>
      Effect.gen(function* () {
        const before = transportState.contextCalls.length;
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "ctx test" }));
        yield* Fiber.join(fiber);

        expect(transportState.contextCalls.length).toBeGreaterThan(before);
        expect(transportState.contextCalls).toContain(threadId);
      }),
    ),
  );
});

// -- Tests with instrumented agent factory ------------------------------------

const {
  state: instrumentedState,
  layer: InstrumentedAgentLayer,
} = makeInstrumentedAgentFactory({ promptDelayMs: 100 });

const { state: instrumentedTransport, layer: InstrumentedTransportLayer } =
  makeTestTransport();

const InstrumentedTestLayer = Layer.mergeAll(
  StoreLayer,
  InstrumentedAgentLayer,
  InstrumentedTransportLayer,
);

it.layer(InstrumentedTestLayer)("agent-thread (instrumented)", (it) => {
  it.live("steering while streaming calls steer directly", () =>
    withThread("t-steer-streaming", (handle) =>
      Effect.gen(function* () {
        const before = instrumentedState.steerCalls.length;
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "streaming" }));
        yield* Effect.sleep("30 millis");

        const result = yield* handle.send(
          ThreadMessage.Steering({ content: "redirect" }),
        );
        expect(result).toBe(true);

        yield* Fiber.join(fiber);
        expect(instrumentedState.steerCalls.length).toBeGreaterThan(before);
        expect(instrumentedState.steerCalls.at(-1)?.content).toBe("redirect");
      }),
    ),
  );

  it.live("steering when not streaming falls through to prompt", () =>
    withThread("t-steer-idle", (handle) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Steering({ content: "as prompt" }));
        const events = yield* Fiber.join(fiber);

        const types = events.map((e) => e.type);
        expect(types).toContain("turn_end");
        expect(types).toContain("agent_end");
      }),
    ),
  );

  it.live("followUp when not streaming triggers continue", () =>
    withThread("t-followup", (handle) =>
      Effect.gen(function* () {
        // Complete a prompt first
        const f1 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "initial" }));
        yield* Fiber.join(f1);
        yield* Effect.yieldNow();

        const beforeFollow = instrumentedState.followUpCalls.length;
        const beforeContinue = instrumentedState.continueCalls;

        yield* handle.send(ThreadMessage.FollowUp({ content: "follow up" }));
        yield* Effect.sleep("50 millis");

        expect(instrumentedState.followUpCalls.length).toBeGreaterThan(
          beforeFollow,
        );
        expect(instrumentedState.continueCalls).toBeGreaterThan(
          beforeContinue,
        );
      }),
    ),
  );

  it.live("rehydration loads existing history on spawn", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const tid = ThreadId.make("t-rehydrate");
      yield* store.getOrCreateThread(TransportId.make("test"), tid);

      // Pre-populate DB with user + assistant messages
      const m1 = yield* store.insertMessage(
        tid,
        null,
        {
          role: "user",
          content: [{ type: "text", text: "old question" }],
          timestamp: Date.now(),
        },
      );
      yield* store.insertMessage(
        tid,
        m1.id,
        {
          role: "assistant",
          content: [{ type: "text", text: "old answer" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "mock",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      );

      const beforeCreate = instrumentedState.createConfigs.length;

      // Spawn thread — should rehydrate with existing messages
      const scope = yield* Scope.make();
      const handle = yield* spawn(testConfig, tid).pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      // Verify factory received the 2 pre-existing messages
      const config = instrumentedState.createConfigs[beforeCreate]!;
      expect(config.messages?.length).toBe(2);

      // Send a new prompt and verify it appends to existing history
      const fiber = yield* Effect.fork(collectUntilEnd(handle));
      yield* handle.send(ThreadMessage.Prompt({ content: "new question" }));
      yield* Fiber.join(fiber);
      yield* Effect.sleep("200 millis");

      const ctx = yield* store.getContext(tid);
      expect(ctx.length).toBeGreaterThanOrEqual(4);
      expect(ctx[0]!.content.role).toBe("user");
      expect(ctx[1]!.content.role).toBe("assistant");
      expect(ctx[2]!.content.role).toBe("user");
      expect(ctx[3]!.content.role).toBe("assistant");

      yield* Scope.close(scope, Exit.void);
    }),
  );
});
