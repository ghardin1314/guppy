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
  OrchestratorLive(testConfig),
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
  it.live("send spawns thread and delivers message", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;

      const deliveredBefore = transportState.delivered.length;

      yield* orchestrator.send(
        "test",
        "chan-2",
        ThreadMessage.Prompt({ content: "hello orchestrator" }),
      );

      yield* Effect.sleep("50 millis");

      const newDelivered = transportState.delivered.slice(deliveredBefore);
      const types = newDelivered.map((d) => d.event.type);
      expect(types).toContain("turn_end");
      expect(types).toContain("agent_end");
    }),
  );

  it.live("events returns null before spawn, stream after", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;

      const before = yield* orchestrator.events("test", "chan-3");
      expect(before).toBeNull();

      yield* orchestrator.send(
        "test",
        "chan-3",
        ThreadMessage.Prompt({ content: "stream test" }),
      );

      yield* Effect.sleep("50 millis");

      const after = yield* orchestrator.events("test", "chan-3");
      expect(after).not.toBeNull();
    }),
  );

  it.live("transport getContext is called before prompt", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;

      const before = transportState.contextCalls.length;

      yield* orchestrator.send(
        "test",
        "chan-4",
        ThreadMessage.Prompt({ content: "ctx check" }),
      );

      yield* Effect.sleep("50 millis");

      expect(transportState.contextCalls.length).toBeGreaterThan(before);
    }),
  );

  it.live("messages persist to SQLite through orchestrator", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* ThreadStore;

      yield* orchestrator.send(
        "test",
        "chan-5",
        ThreadMessage.Prompt({ content: "persist through orch" }),
      );

      yield* Effect.sleep("50 millis");

      const thread = yield* store.getOrCreateThread("test", "chan-5");
      const ctx = yield* store.getContext(thread.id);
      expect(ctx.length).toBeGreaterThanOrEqual(2);
      expect(ctx[0]!.role).toBe("user");
      expect(ctx[1]!.role).toBe("assistant");
    }),
  );

  it.live("send to same thread twice reuses spawned handle", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* ThreadStore;

      yield* orchestrator.send(
        "test",
        "chan-reuse",
        ThreadMessage.Prompt({ content: "first" }),
      );
      yield* Effect.sleep("50 millis");

      yield* orchestrator.send(
        "test",
        "chan-reuse",
        ThreadMessage.Prompt({ content: "second" }),
      );
      yield* Effect.sleep("50 millis");

      const thread = yield* store.getOrCreateThread("test", "chan-reuse");
      const ctx = yield* store.getContext(thread.id);
      expect(ctx.length).toBeGreaterThanOrEqual(4);
    }),
  );

  it.live("same channelId on different transports creates separate threads", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* ThreadStore;

      const aBefore = transportAState.delivered.length;
      const bBefore = transportBState.delivered.length;

      yield* orchestrator.send(
        "transport-a",
        "chan-multi",
        ThreadMessage.Prompt({ content: "for A" }),
      );
      yield* Effect.sleep("50 millis");

      yield* orchestrator.send(
        "transport-b",
        "chan-multi",
        ThreadMessage.Prompt({ content: "for B" }),
      );
      yield* Effect.sleep("50 millis");

      const aDelivered = transportAState.delivered.slice(aBefore);
      const bDelivered = transportBState.delivered.slice(bBefore);

      // Each transport received events
      expect(aDelivered.length).toBeGreaterThan(0);
      expect(bDelivered.length).toBeGreaterThan(0);

      // Separate threads created
      const threadA = yield* store.getOrCreateThread("transport-a", "chan-multi");
      const threadB = yield* store.getOrCreateThread("transport-b", "chan-multi");
      expect(threadA.id).not.toBe(threadB.id);

      // No cross-talk
      expect(aDelivered.every((d) => d.threadId === threadA.id)).toBe(true);
      expect(bDelivered.every((d) => d.threadId === threadB.id)).toBe(true);
    }),
  );

  it.live("send to unknown transport fails with TransportNotFoundError", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;

      const error = yield* orchestrator
        .send(
          "nonexistent",
          "chan-unknown-transport",
          ThreadMessage.Prompt({ content: "hello" }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(TransportNotFoundError);
      expect((error as TransportNotFoundError).name).toBe("nonexistent");
    }),
  );
});
