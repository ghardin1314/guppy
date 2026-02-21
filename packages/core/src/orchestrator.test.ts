import { expect } from "bun:test";
import { DateTime, Effect, Either, Layer } from "effect";
import { makeDbLayer } from "./db.ts";
import { EventBus } from "./event-bus.ts";
import { ScheduleStore } from "./event-store.ts";
import { ThreadStore } from "./repository.ts";
import { Orchestrator } from "./orchestrator.ts";
import { TransportRegistry } from "./transport-registry.ts";
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
const StoreLayer = Layer.provideMerge(ThreadStore.layer, DbLayer);
const ScheduleStoreLayer = Layer.provideMerge(ScheduleStore.layer, DbLayer);
const BusLayer = Layer.provideMerge(EventBus.layer, ScheduleStoreLayer);

// Shared registry — both TransportMap and registration use the same instance
const RegistryLayer = TransportRegistry.layer;

const TransportMapLayer = Layer.provide(
  TransportMap.DefaultWithoutDependencies,
  RegistryLayer,
);

const RegisterLayer = Layer.provide(RegisterTransportLayer, RegistryLayer);
const RegisterALayer = Layer.provide(RegisterATransport, RegistryLayer);
const RegisterBLayer = Layer.provide(RegisterBTransport, RegistryLayer);

const OrchestratorLayer = Layer.provide(
  Orchestrator.layer(testConfig),
  Layer.mergeAll(StoreLayer, EchoAgentFactoryLive, TransportMapLayer, BusLayer),
);

const TestLayer = Layer.mergeAll(
  StoreLayer,
  ScheduleStoreLayer,
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
      expect(ctx[0]!.content.role).toBe("user");
      expect(ctx[1]!.content.role).toBe("assistant");
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

  it.live("scheduleMessage returns a pending schedule", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator;

      const scheduledAt = DateTime.unsafeMakeZoned(Date.now() + 60000, {
        timeZone: "UTC",
      });
      const schedule = yield* orch.scheduleMessage(
        TEST,
        tid("sched-1"),
        "hello later",
        { type: "delayed", scheduledAt },
      );

      expect(schedule.id).toBeDefined();
      expect(schedule.status).toBe("pending");
      expect(schedule.eventType).toBe("agent.message");
      expect(schedule.scheduleType).toBe("delayed");
    }),
  );

  it.live("scheduled message fires and delivers to thread", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator;

      const deliveredBefore = transportState.delivered.length;

      const scheduledAt = DateTime.unsafeMakeZoned(Date.now() + 100, {
        timeZone: "UTC",
      });
      yield* orch.scheduleMessage(
        TEST,
        tid("sched-fire"),
        "scheduled prompt",
        { type: "delayed", scheduledAt },
      );

      // Wait for schedule to fire + echo agent to respond
      yield* Effect.sleep("300 millis");

      const newDelivered = transportState.delivered.slice(deliveredBefore);
      const types = newDelivered.map((d) => d.event.type);
      expect(types).toContain("agent_end");
    }),
  );

  it.live("cancelSchedule prevents delivery", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator;

      const deliveredBefore = transportState.delivered.length;

      const scheduledAt = DateTime.unsafeMakeZoned(Date.now() + 200, {
        timeZone: "UTC",
      });
      const schedule = yield* orch.scheduleMessage(
        TEST,
        tid("sched-cancel"),
        "should not fire",
        { type: "delayed", scheduledAt },
      );

      yield* orch.cancelSchedule(schedule.id);

      yield* Effect.sleep("400 millis");

      const newDelivered = transportState.delivered.slice(deliveredBefore);
      expect(newDelivered).toHaveLength(0);
    }),
  );

  it.live("scheduleMessage with cron returns schedule", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator;

      const schedule = yield* orch.scheduleMessage(
        TEST,
        tid("sched-cron"),
        "cron msg",
        { type: "cron", cronExpression: "0 9 * * MON" },
      );

      expect(schedule.id).toBeDefined();
      expect(schedule.status).toBe("pending");
      expect(schedule.scheduleType).toBe("cron");

      // Clean up
      yield* orch.cancelSchedule(schedule.id);
    }),
  );

  it.live("scheduleMessage with invalid cron rejects", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator;

      const result = yield* orch
        .scheduleMessage(TEST, tid("sched-bad"), "nope", {
          type: "cron",
          cronExpression: "not a cron",
        })
        .pipe(Effect.either);

      expect(Either.isLeft(result)).toBe(true);
    }),
  );

  it.live("scheduled message persists in schedule store", () =>
    Effect.gen(function* () {
      const orch = yield* Orchestrator;
      const store = yield* ScheduleStore;

      const scheduledAt = DateTime.unsafeMakeZoned(Date.now() + 60000, {
        timeZone: "UTC",
      });
      yield* orch.scheduleMessage(
        TEST,
        tid("sched-persist"),
        "persist me",
        { type: "delayed", scheduledAt },
      );

      const pending = yield* store.getPendingSchedules("delayed");
      const match = pending.find((s) => s.eventType === "agent.message");
      expect(match).toBeDefined();
    }),
  );
});
