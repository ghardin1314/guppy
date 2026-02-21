import { expect, test } from "bun:test";
import {
  Context,
  DateTime,
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  TestClock,
} from "effect";
import { makeDbLayer } from "./db.ts";
import { EventBus } from "./event-bus.ts";
import { ScheduleStore } from "./event-store.ts";
import type { BusEvent } from "./schema.ts";
import { it } from "./test.ts";

// -- Test subscriber (mimics production subscriber pattern) -------------------

interface TestSubscriberService {
  readonly received: Effect.Effect<ReadonlyArray<BusEvent>>;
}

class TestSubscriber extends Context.Tag("TestSubscriber")<
  TestSubscriber,
  TestSubscriberService
>() {}

const TestSubscriberLive = Layer.effect(
  TestSubscriber,
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const events: BusEvent[] = [];

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

const agentMsg = (target: string, payload: string): BusEvent => ({
  type: "agent.message",
  targetThreadId: target,
  payload,
});

const StoreLayer = Layer.provideMerge(ScheduleStore.layer, makeDbLayer(":memory:"));
const BusLayer = Layer.provideMerge(EventBus.layer, StoreLayer);
const SubscribedLayer = Layer.provideMerge(TestSubscriberLive, BusLayer);

// -- Tests with subscriber (production pattern) -------------------------------

it.layer(SubscribedLayer)("event-bus: subscriber", (it) => {
  it.effect("emit delivers to matching subscriber", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      yield* bus.emit(agentMsg("thread-1", "hello"));

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe("agent.message");
      expect(received[0]!.payload).toBe("hello");
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
      const schedule = yield* bus.schedule(agentMsg("sched-1", "later"), {
        type: "delayed",
        scheduledAt,
      });

      expect(schedule.scheduleType).toBe("delayed");
      expect(schedule.status).toBe("pending");
      expect(yield* sub.received).toHaveLength(0);

      yield* TestClock.adjust("5 seconds");
      yield* Effect.yieldNow();

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe("later");
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
      yield* bus.schedule(agentMsg("sched-2", "wait"), {
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
      const schedule = yield* bus.schedule(agentMsg("cancel-1", "nope"), {
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

      yield* bus.schedule(agentMsg("cron-1", "tick"), {
        type: "cron",
        cronExpression: "* * * * *",
      });

      expect(yield* sub.received).toHaveLength(0);

      yield* TestClock.adjust("1 minute");
      yield* Effect.yieldNow();

      const received = yield* sub.received;
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe("tick");
    }),
  );

  it.effect("cron fires repeatedly across ticks", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const sub = yield* TestSubscriber;

      yield* bus.schedule(agentMsg("cron-2", "repeat"), {
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

      const schedule = yield* bus.schedule(agentMsg("cron-cancel", "stop"), {
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
        .schedule(agentMsg("cron-bad", "nope"), {
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
  it.effect("emit with no matching subscriber is a no-op", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      // Should not throw
      yield* bus.emit(agentMsg("no-one", "hello"));
    }),
  );

  it.effect("emit delivers to multiple matching subscribers", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received1: BusEvent[] = [];
      const received2: BusEvent[] = [];

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

      yield* bus.emit(agentMsg("thread-1", "multi"));

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    }),
  );

  it.effect("glob pattern filters non-matching events", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received: BusEvent[] = [];

      yield* bus.subscribe("narrow-sub", "thread.*", (e) =>
        Effect.sync(() => {
          received.push(e);
        }),
      );

      yield* bus.emit(agentMsg("thread-1", "miss"));
      expect(received).toHaveLength(0);
    }),
  );

  it.effect("handler errors are ignored (do not propagate)", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received: BusEvent[] = [];

      yield* bus.subscribe("bad-sub", "agent.*", () => Effect.fail("boom"));
      yield* bus.subscribe("good-sub", "agent.*", (e) =>
        Effect.sync(() => {
          received.push(e);
        }),
      );

      // Should not throw despite bad-sub failing
      yield* bus.emit(agentMsg("thread-1", "ok"));
      expect(received).toHaveLength(1);
    }),
  );

  it.effect("unsubscribe stops delivery", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received: BusEvent[] = [];

      yield* bus.subscribe("unsub-test", "agent.*", (e) =>
        Effect.sync(() => {
          received.push(e);
        }),
      );

      yield* bus.emit(agentMsg("thread-1", "first"));
      expect(received).toHaveLength(1);

      yield* bus.unsubscribe("unsub-test");
      yield* bus.emit(agentMsg("thread-1", "second"));
      expect(received).toHaveLength(1);
    }),
  );
});

// -- recovery (ManagedRuntime stop/start) -----------------------------------

const makeAppLayer = (dbPath: string) => {
  const db = makeDbLayer(dbPath);
  const storeLayer = Layer.provideMerge(ScheduleStore.layer, db);
  return Layer.provideMerge(EventBus.layer, storeLayer);
};

test("recovery: scheduled event survives restart", async () => {
  const dbPath = `/tmp/guppy-test-recovery-${Date.now()}.db`;
  const appLayer = makeAppLayer(dbPath);

  // -- First lifetime: persist a pending schedule, then shut down --
  const rt1 = ManagedRuntime.make(appLayer);
  await rt1.runPromise(
    Effect.gen(function* () {
      const store = yield* ScheduleStore;
      yield* store.insertSchedule({
        eventType: "agent.message",
        eventData: JSON.stringify(agentMsg("persist-thread", "survived")),
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
      expect(received[0]!.payload).toBe("survived");
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
      const store = yield* ScheduleStore;
      yield* store.insertSchedule({
        eventType: "agent.message",
        eventData: JSON.stringify(agentMsg("overdue-thread", "overdue")),
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
      expect(received[0]!.payload).toBe("overdue");
    }),
  );
  await rt2.dispose();

  const fs = await import("node:fs/promises");
  await fs.unlink(dbPath).catch(() => {});
});
