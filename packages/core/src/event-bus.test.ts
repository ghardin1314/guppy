import { expect, test } from "bun:test";
import {
  Context,
  DateTime,
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  Schema,
  TestClock,
} from "effect";
import { parseJson } from "effect/Schema";
import { makeDbLayer } from "./db.ts";
import { EventBus, EventBusLive } from "./event-bus.ts";
import { EventStore, EventStoreLive } from "./event-store.ts";
import type { GuppyEvent } from "./schema.ts";
import { GuppyEvent as GuppyEventSchema } from "./schema.ts";
import { it } from "./test.ts";

// -- Test subscriber (mimics production subscriber pattern) -------------------

interface TestSubscriberService {
  readonly received: Effect.Effect<ReadonlyArray<GuppyEvent>>;
}

class TestSubscriber extends Context.Tag("TestSubscriber")<
  TestSubscriber,
  TestSubscriberService
>() {}

const TestSubscriberLive = Layer.effect(
  TestSubscriber,
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const events: GuppyEvent[] = [];

    yield* bus.subscribe("test-subscriber", "agent.*", (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    );

    return TestSubscriber.of({
      received: Effect.sync(() => [...events]),
    });
  }),
);

// -- Layers -------------------------------------------------------------------

const agentMsg = (
  target: string,
  payload: string,
  source?: string,
): GuppyEvent => ({
  type: "agent.message",
  targetThreadId: target,
  sourceThreadId: source ?? null,
  payload,
});

const StoreLayer = Layer.provideMerge(EventStoreLive, makeDbLayer(":memory:"));
const BusLayer = Layer.provideMerge(EventBusLive, StoreLayer);
const SubscribedLayer = Layer.provideMerge(TestSubscriberLive, BusLayer);

// -- Tests with subscriber (production pattern) -------------------------------

it.layer(SubscribedLayer)("event-bus: subscriber", (it) => {
  it.effect("emit delivers to matching subscriber", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      const deliveries = yield* bus.emit(
        agentMsg("thread-1", '{"msg":"hello"}'),
      );

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe("delivered");
      expect(deliveries[0]!.subscriberId).toBe("test-subscriber");

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe("agent.message");
    }),
  );

  it.effect("emit persists deliveries for auditability", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;

      yield* bus.emit(agentMsg("audit", '{"action":"test"}'));
      const deliveries = yield* bus.getDeliveries("test-subscriber");

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe("delivered");
    }),
  );

  it.effect("schedule fires after delay", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      const now = yield* TestClock.currentTimeMillis;
      const scheduledAt = DateTime.unsafeMakeZoned(now + 5000, {
        timeZone: "UTC",
      });
      const schedule = yield* bus.schedule(
        agentMsg("sched-1", '{"t":"later"}'),
        { type: "delayed", scheduledAt },
      );

      expect(schedule.scheduleType).toBe("delayed");
      expect(schedule.status).toBe("pending");
      expect(yield* sub.received).toHaveLength(0);

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow();

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe('{"t":"later"}');
    }),
  );

  it.effect("schedule does not fire before its time", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      const now = yield* TestClock.currentTimeMillis;
      const scheduledAt = DateTime.unsafeMakeZoned(now + 10000, {
        timeZone: "UTC",
      });
      yield* bus.schedule(agentMsg("sched-2", "{}"), {
        type: "delayed",
        scheduledAt,
      });

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(0);

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(1);
    }),
  );

  it.effect("cancel prevents scheduled delivery", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      const now = yield* TestClock.currentTimeMillis;
      const scheduledAt = DateTime.unsafeMakeZoned(now + 5000, {
        timeZone: "UTC",
      });
      const schedule = yield* bus.schedule(agentMsg("cancel-1", "{}"), {
        type: "delayed",
        scheduledAt,
      });

      yield* bus.cancel(schedule.id);

      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(0);
    }),
  );
});

// -- Cron delivery tests ------------------------------------------------------

it.layer(SubscribedLayer)("event-bus: cron", (it) => {
  it.effect("cron fires at the right time", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      yield* bus.schedule(agentMsg("cron-1", '{"cron":true}'), {
        type: "cron",
        cronExpression: "* * * * *",
      });

      expect(yield* sub.received).toHaveLength(0);

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow();

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe('{"cron":true}');
    }),
  );

  it.effect("cron fires repeatedly across ticks", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      yield* bus.schedule(agentMsg("cron-2", '{"repeat":true}'), {
        type: "cron",
        cronExpression: "* * * * *",
      });

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(1);

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(2);

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(3);
    }),
  );

  it.effect("cron cancel stops future fires", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      const schedule = yield* bus.schedule(agentMsg("cron-cancel", "{}"), {
        type: "cron",
        cronExpression: "* * * * *",
      });

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(1);

      yield* bus.cancel(schedule.id);

      yield* TestClock.adjust("5 minutes");
      yield* Effect.yieldNow();
      expect(yield* sub.received).toHaveLength(1);
    }),
  );

  it.effect("invalid cron expression is rejected", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;

      const result = yield* bus
        .schedule(agentMsg("cron-bad", "{}"), {
          type: "cron",
          cronExpression: "not a cron",
        })
        .pipe(Effect.either);

      expect(Either.isLeft(result)).toBe(true);
    }),
  );
});

// -- Tests with manual setup (edge cases) -------------------------------------

it.layer(BusLayer)("event-bus: edge cases", (it) => {
  it.effect("emit with no matching subscriber returns empty", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const deliveries = yield* bus.emit(agentMsg("no-one", "{}"));
      expect(deliveries).toHaveLength(0);
    }),
  );

  it.effect("emit delivers to multiple matching subscribers", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received1: GuppyEvent[] = [];
      const received2: GuppyEvent[] = [];

      yield* bus.subscribe("sub-a", "agent.message", (e) =>
        Effect.sync(() => {
          received1.push(e);
        }),
      );
      yield* bus.subscribe("sub-b", "*", (e) =>
        Effect.sync(() => {
          received2.push(e);
        }),
      );

      const deliveries = yield* bus.emit(agentMsg("thread-1", "{}"));

      expect(deliveries).toHaveLength(2);
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    }),
  );

  it.effect("glob pattern filters non-matching events", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received: GuppyEvent[] = [];

      yield* bus.subscribe("narrow-sub", "thread.*", (e) =>
        Effect.sync(() => {
          received.push(e);
        }),
      );

      yield* bus.emit(agentMsg("thread-1", "{}"));
      expect(received).toHaveLength(0);
    }),
  );

  it.effect("emit retries then dead-letters on repeated failure", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      let attempts = 0;

      yield* bus.subscribe("flaky-sub", "agent.*", () =>
        Effect.gen(function* () {
          attempts++;
          yield* Effect.fail("boom");
        }),
      );

      const deliveries = yield* bus.emit(agentMsg("flaky", "{}"));

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.status).toBe("dead_letter");
      expect(deliveries[0]!.retryCount).toBe(3);
      expect(deliveries[0]!.lastError).toBe("boom");
      expect(attempts).toBe(3);
    }),
  );

  it.effect("per-subscriber dead letter independence", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;

      yield* bus.subscribe("good-sub", "agent.*", () => Effect.void);
      yield* bus.subscribe("bad-sub", "agent.*", () => Effect.fail("nope"));

      const deliveries = yield* bus.emit(agentMsg("thread-1", "{}"));

      expect(deliveries).toHaveLength(2);
      const good = deliveries.find((d) => d.subscriberId === "good-sub")!;
      const bad = deliveries.find((d) => d.subscriberId === "bad-sub")!;
      expect(good.status).toBe("delivered");
      expect(bad.status).toBe("dead_letter");
    }),
  );

  it.effect("replayDeadLetter retries a failed delivery", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      let shouldFail = true;

      yield* bus.subscribe("retry-sub", "agent.*", () =>
        shouldFail ? Effect.fail("not yet") : Effect.void,
      );

      const deliveries = yield* bus.emit(agentMsg("retry-target", "{}"));
      expect(deliveries[0]!.status).toBe("dead_letter");

      shouldFail = false;
      const replayed = yield* bus.replayDeadLetter(deliveries[0]!.id);
      expect(replayed.status).toBe("delivered");
    }),
  );

  it.effect("unsubscribe stops delivery", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received: GuppyEvent[] = [];

      yield* bus.subscribe("unsub-test", "agent.*", (e) =>
        Effect.sync(() => {
          received.push(e);
        }),
      );

      yield* bus.emit(agentMsg("thread-1", "{}"));
      expect(received).toHaveLength(1);

      yield* bus.unsubscribe("unsub-test");
      yield* bus.emit(agentMsg("thread-1", "{}"));
      expect(received).toHaveLength(1);
    }),
  );
});

// -- recovery (ManagedRuntime stop/start) -----------------------------------

const makeAppLayer = (dbPath: string) => {
  const db = makeDbLayer(dbPath);
  const storeLayer = Layer.provideMerge(EventStoreLive, db);
  return Layer.provideMerge(EventBusLive, storeLayer);
};

test("recovery: scheduled event survives restart", async () => {
  const dbPath = `/tmp/guppy-test-recovery-${Date.now()}.db`;
  const appLayer = makeAppLayer(dbPath);

  // -- First lifetime: persist a pending schedule, then shut down --
  const rt1 = ManagedRuntime.make(appLayer);
  await rt1.runPromise(
    Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.insertSchedule({
        eventType: "agent.message",
        eventData: Schema.encodeSync(parseJson(GuppyEventSchema))(
          agentMsg("persist-thread", '{"survived":true}'),
        ),
        scheduleType: "delayed",
        scheduledAt: Date.now() + 100,
        cronExpression: null,
      });
    }),
  );
  await rt1.dispose();

  // -- Second lifetime: TestSubscriber registers on startup, then recovers --
  const subscribedLayer = Layer.provideMerge(TestSubscriberLive, appLayer);
  const rt2 = ManagedRuntime.make(subscribedLayer);
  await rt2.runPromise(
    Effect.gen(function* () {
      const sub = yield* TestSubscriber;

      yield* Effect.sleep("200 millis");

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe('{"survived":true}');
    }),
  );
  await rt2.dispose();

  const fs = await import("node:fs/promises");
  await fs.unlink(dbPath).catch(() => {});
});

test("recovery: overdue event fires immediately on restart", async () => {
  const dbPath = `/tmp/guppy-test-overdue-${Date.now()}.db`;
  const appLayer = makeAppLayer(dbPath);

  // -- First lifetime: insert an already-overdue schedule --
  const rt1 = ManagedRuntime.make(appLayer);
  await rt1.runPromise(
    Effect.gen(function* () {
      const store = yield* EventStore;
      yield* store.insertSchedule({
        eventType: "agent.message",
        eventData: Schema.encodeSync(parseJson(GuppyEventSchema))(
          agentMsg("overdue-thread", '{"overdue":true}'),
        ),
        scheduleType: "delayed",
        scheduledAt: Date.now() - 5000,
        cronExpression: null,
      });
    }),
  );
  await rt1.dispose();

  // -- Second lifetime: TestSubscriber registers on startup, overdue fires --
  const subscribedLayer = Layer.provideMerge(TestSubscriberLive, appLayer);
  const rt2 = ManagedRuntime.make(subscribedLayer);
  await rt2.runPromise(
    Effect.gen(function* () {
      const sub = yield* TestSubscriber;

      yield* Effect.sleep("100 millis");

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe('{"overdue":true}');
    }),
  );
  await rt2.dispose();

  const fs = await import("node:fs/promises");
  await fs.unlink(dbPath).catch(() => {});
});
