import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { makeDbLayer } from "./db.ts";
import { ThreadStoreLive, ThreadStore } from "./repository.ts";
import { Orchestrator } from "./orchestrator.ts";
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
import { TransportId, ThreadId } from "./schema.ts";

const TEST = TransportId.make("test");
const A = TransportId.make("transport-a");
const B = TransportId.make("transport-b");
const tid = ThreadId.make;

// -- Test transport -----------------------------------------------------------

const { state: transportState, layer: RegisterTransportLayer } =
  makeRegisteredTestTransport(TEST);
const { state: transportAState, layer: RegisterATransport } =
  makeRegisteredTestTransport(A);
const { state: transportBState, layer: RegisterBTransport } =
  makeRegisteredTestTransport(B);

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
  Orchestrator.layer(testConfig),
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
        TEST,
        tid("chan-2"),
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

      const before = yield* orchestrator.events(TEST, tid("chan-3"));
      expect(before).toBeNull();

      yield* orchestrator.send(
        TEST,
        tid("chan-3"),
        ThreadMessage.Prompt({ content: "stream test" }),
      );

      yield* Effect.sleep("50 millis");

      const after = yield* orchestrator.events(TEST, tid("chan-3"));
      expect(after).not.toBeNull();
    }),
  );

  it.live("transport getContext is called before prompt", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;

      const before = transportState.contextCalls.length;

      yield* orchestrator.send(
        TEST,
        tid("chan-4"),
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
        TEST,
        tid("chan-5"),
        ThreadMessage.Prompt({ content: "persist through orch" }),
      );

      yield* Effect.sleep("50 millis");

      const thread = yield* store.getOrCreateThread(TEST, tid("chan-5"));
      const ctx = yield* store.getContext(thread.threadId);
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
        TEST,
        tid("chan-reuse"),
        ThreadMessage.Prompt({ content: "first" }),
      );
      yield* Effect.sleep("50 millis");

      yield* orchestrator.send(
        TEST,
        tid("chan-reuse"),
        ThreadMessage.Prompt({ content: "second" }),
      );
      yield* Effect.sleep("50 millis");

      const thread = yield* store.getOrCreateThread(TEST, tid("chan-reuse"));
      const ctx = yield* store.getContext(thread.threadId);
      expect(ctx.length).toBeGreaterThanOrEqual(4);
    }),
  );

  it.live("different transports route events independently", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;

      const aBefore = transportAState.delivered.length;
      const bBefore = transportBState.delivered.length;

      yield* orchestrator.send(
        A,
        tid("a-thread"),
        ThreadMessage.Prompt({ content: "for A" }),
      );
      yield* Effect.sleep("50 millis");

      yield* orchestrator.send(
        B,
        tid("b-thread"),
        ThreadMessage.Prompt({ content: "for B" }),
      );
      yield* Effect.sleep("50 millis");

      const aDelivered = transportAState.delivered.slice(aBefore);
      const bDelivered = transportBState.delivered.slice(bBefore);

      // Each transport received events
      expect(aDelivered.length).toBeGreaterThan(0);
      expect(bDelivered.length).toBeGreaterThan(0);

      // No cross-talk
      expect(aDelivered.every((d) => d.threadId === tid("a-thread"))).toBe(true);
      expect(bDelivered.every((d) => d.threadId === tid("b-thread"))).toBe(true);
    }),
  );

  it.live("send to unknown transport fails with TransportNotFoundError", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;

      const error = yield* orchestrator
        .send(
          TransportId.make("nonexistent"),
          tid("chan-unknown-transport"),
          ThreadMessage.Prompt({ content: "hello" }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(TransportNotFoundError);
      expect((error as TransportNotFoundError).name).toBe("nonexistent");
    }),
  );
});
