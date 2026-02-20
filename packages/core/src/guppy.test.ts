import { test, expect, describe, afterEach } from "bun:test";
import { Effect, Layer } from "effect";
import { Guppy } from "./guppy.ts";
import { EchoAgentFactoryLive, testConfig } from "./testing.ts";
import { EventBus } from "./event-bus.ts";
import { TransportRegistry } from "./transport-registry.ts";
import { TransportId } from "./schema.ts";
import type { GuppyEvent } from "./schema.ts";

function createTestGuppy() {
  return Guppy._createWithFactory(
    { projectDir: "/tmp/guppy-test", agent: testConfig, db: ":memory:" },
    EchoAgentFactoryLive,
  );
}

describe("Guppy", () => {
  let guppy: Guppy;

  afterEach(async () => {
    await guppy?.shutdown();
  });

  test("boot + shutdown", async () => {
    guppy = createTestGuppy();
    await guppy.boot();
    await guppy.shutdown();
  });

  test("emit delivers to bus subscribers", async () => {
    guppy = createTestGuppy();
    await guppy.boot();

    const delivered: GuppyEvent[] = [];

    // Subscribe via runEffect
    await guppy.runEffect(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribe("test-sub", "*", (event) =>
          Effect.sync(() => {
            delivered.push(event);
          }),
        );
      }),
    );

    const event: GuppyEvent = {
      type: "agent.message",
      targetThreadId: "t1",
      sourceThreadId: null,
      payload: "hello",
    };

    guppy.emit(event);

    // Give the fork time to deliver
    await Bun.sleep(100);

    expect(delivered.length).toBe(1);
    expect(delivered[0]!.type).toBe("agent.message");
  });

  test("schedule returns EventSchedule", async () => {
    guppy = createTestGuppy();
    await guppy.boot();

    const event: GuppyEvent = {
      type: "agent.message",
      targetThreadId: "t1",
      sourceThreadId: null,
      payload: "scheduled",
    };

    const schedule = await guppy.schedule(event, {
      type: "delayed",
      scheduledAt: new Date("2099-01-01T00:00:00Z"),
    } as never);

    expect(schedule.id).toBeDefined();
    expect(schedule.status).toBe("pending");
    expect(schedule.eventType).toBe("agent.message");
  });

  test("register wires transport layer", async () => {
    let constructed = false;

    const transportLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const registry = yield* TransportRegistry;
        yield* registry.register(TransportId.make("test-transport"), {
          getContext: () => Effect.succeed(""),
          deliver: () => Effect.void,
        });
        constructed = true;
      }),
    );

    guppy = createTestGuppy().register({ layer: transportLayer });
    await guppy.boot();

    expect(constructed).toBe(true);
  });

  test("not-booted throws on emit", () => {
    guppy = createTestGuppy();

    expect(() =>
      guppy.emit({
        type: "agent.message",
        targetThreadId: "t1",
        sourceThreadId: null,
        payload: "hello",
      }),
    ).toThrow("Guppy not booted");
  });

  test("double boot throws", async () => {
    guppy = createTestGuppy();
    await guppy.boot();
    await expect(guppy.boot()).rejects.toThrow("Guppy already booted");
  });
});
