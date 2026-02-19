import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { makeDbLayer } from "./db.ts";
import { ThreadStoreLive, ThreadStore } from "./repository.ts";
import { Orchestrator, OrchestratorLive } from "./orchestrator.ts";
import { TransportRegistryLive } from "./transport-registry.ts";
import { TransportMap } from "./transport-map.ts";
import { ThreadMessage } from "./thread-message.ts";
import {
  it,
  EchoAgentFactoryLive,
  makeRegisteredTestTransport,
  testConfig,
} from "./testing.ts";
import { TransportNotFoundError } from "./transport-registry.ts";

// -- Test transport -----------------------------------------------------------

const { state: transportState, layer: RegisterTransportLayer } =
  makeRegisteredTestTransport("test");
const { state: transportAState, layer: RegisterATransport } =
  makeRegisteredTestTransport("transport-a");
const { state: transportBState, layer: RegisterBTransport } =
  makeRegisteredTestTransport("transport-b");

// -- Layers -------------------------------------------------------------------

const DbLayer = makeDbLayer(":memory:");
const StoreLayer = Layer.provideMerge(ThreadStoreLive, DbLayer);

// Shared registry — both TransportMap and registration use the same instance
const RegistryLayer = TransportRegistryLive;

const TransportMapLayer = Layer.provide(
  TransportMap.DefaultWithoutDependencies,
  RegistryLayer,
);

const RegisterLayer = Layer.provide(RegisterTransportLayer, RegistryLayer);
const RegisterALayer = Layer.provide(RegisterATransport, RegistryLayer);
const RegisterBLayer = Layer.provide(RegisterBTransport, RegistryLayer);

const OrchestratorLayer = Layer.provide(
  OrchestratorLive,
  Layer.mergeAll(StoreLayer, EchoAgentFactoryLive, TransportMapLayer),
);

const TestLayer = Layer.mergeAll(
  StoreLayer,
  EchoAgentFactoryLive,
  OrchestratorLayer,
  RegisterLayer,
  RegisterALayer,
  RegisterBLayer,
);

// -- Tests --------------------------------------------------------------------

it.layer(TestLayer)("orchestrator", (it) => {
  it.live("getOrCreateThread creates and returns thread id", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const threadId = yield* orchestrator.getOrCreateThread("test", "chan-1");
      expect(typeof threadId).toBe("string");
      expect(threadId.length).toBeGreaterThan(0);

      // Same transport + channel returns same thread
      const threadId2 = yield* orchestrator.getOrCreateThread("test", "chan-1");
      expect(threadId2).toBe(threadId);
    }),
  );

  it.live("send spawns thread and delivers message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const threadId = yield* orchestrator.getOrCreateThread("test", "chan-2");

      const deliveredBefore = transportState.delivered.length;

      yield* orchestrator.send(
        threadId,
        "test",
        ThreadMessage.Prompt({ content: "hello orchestrator" }),
        testConfig,
      );

      yield* Effect.sleep("50 millis");

      const newDelivered = transportState.delivered.slice(deliveredBefore);
      const types = newDelivered.map((d) => d.event.type);
      expect(types).toContain("turn_end");
      expect(types).toContain("agent_end");
    }),
  );

  it.live("events returns stream for running thread", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const threadId = yield* orchestrator.getOrCreateThread("test", "chan-3");

      const before = yield* orchestrator.events(threadId);
      expect(before).toBeNull();

      yield* orchestrator.send(
        threadId,
        "test",
        ThreadMessage.Prompt({ content: "stream test" }),
        testConfig,
      );

      yield* Effect.sleep("50 millis");

      const after = yield* orchestrator.events(threadId);
      expect(after).not.toBeNull();
    }),
  );

  it.live("transport getContext is called before prompt", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const threadId = yield* orchestrator.getOrCreateThread("test", "chan-4");

      const before = transportState.contextCalls.length;

      yield* orchestrator.send(
        threadId,
        "test",
        ThreadMessage.Prompt({ content: "ctx check" }),
        testConfig,
      );

      yield* Effect.sleep("50 millis");

      expect(transportState.contextCalls.length).toBeGreaterThan(before);
      expect(transportState.contextCalls).toContain(threadId);
    }),
  );

  it.live("messages persist to SQLite through orchestrator", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* ThreadStore;
      const threadId = yield* orchestrator.getOrCreateThread("test", "chan-5");

      yield* orchestrator.send(
        threadId,
        "test",
        ThreadMessage.Prompt({ content: "persist through orch" }),
        testConfig,
      );

      yield* Effect.sleep("50 millis");

      const ctx = yield* store.getContext(threadId);
      expect(ctx.length).toBeGreaterThanOrEqual(2);
      expect(ctx[0]!.role).toBe("user");
      expect(ctx[1]!.role).toBe("assistant");
    }),
  );

  it.live("send to same thread twice reuses spawned handle", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* ThreadStore;
      const threadId = yield* orchestrator.getOrCreateThread("test", "chan-reuse");

      yield* orchestrator.send(
        threadId,
        "test",
        ThreadMessage.Prompt({ content: "first" }),
        testConfig,
      );
      yield* Effect.sleep("50 millis");

      yield* orchestrator.send(
        threadId,
        "test",
        ThreadMessage.Prompt({ content: "second" }),
        testConfig,
      );
      yield* Effect.sleep("50 millis");

      // Both prompts processed → 4 messages (2 user + 2 assistant)
      const ctx = yield* store.getContext(threadId);
      expect(ctx.length).toBeGreaterThanOrEqual(4);
    }),
  );

  it.live("routes messages to correct transport (no cross-talk)", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const threadA = yield* orchestrator.getOrCreateThread(
        "transport-a",
        "chan-multi",
      );
      const threadB = yield* orchestrator.getOrCreateThread(
        "transport-b",
        "chan-multi",
      );

      const aBefore = transportAState.delivered.length;
      const bBefore = transportBState.delivered.length;

      yield* orchestrator.send(
        threadA,
        "transport-a",
        ThreadMessage.Prompt({ content: "for A" }),
        testConfig,
      );
      yield* Effect.sleep("50 millis");

      yield* orchestrator.send(
        threadB,
        "transport-b",
        ThreadMessage.Prompt({ content: "for B" }),
        testConfig,
      );
      yield* Effect.sleep("50 millis");

      const aDelivered = transportAState.delivered.slice(aBefore);
      const bDelivered = transportBState.delivered.slice(bBefore);

      // Each transport received events for its own thread
      expect(aDelivered.length).toBeGreaterThan(0);
      expect(bDelivered.length).toBeGreaterThan(0);

      // No cross-talk
      expect(aDelivered.every((d) => d.threadId === threadA)).toBe(true);
      expect(bDelivered.every((d) => d.threadId === threadB)).toBe(true);
    }),
  );

  it.live("send to unknown transport fails with TransportNotFoundError", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const threadId = yield* orchestrator.getOrCreateThread(
        "test",
        "chan-unknown-transport",
      );

      const error = yield* orchestrator
        .send(
          threadId,
          "nonexistent",
          ThreadMessage.Prompt({ content: "hello" }),
          testConfig,
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(TransportNotFoundError);
      expect((error as TransportNotFoundError).name).toBe("nonexistent");
    }),
  );
});
