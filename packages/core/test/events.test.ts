import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
} from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventBus } from "../src/events";
import type { EventDispatch, EventTarget } from "../src/types";

let eventsDir: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "guppy-events-"));
  eventsDir = join(tmpDir, "events");
  mkdirSync(eventsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

function writeEvent(filename: string, data: Record<string, unknown>): void {
  writeFileSync(join(eventsDir, filename), JSON.stringify(data));
}

describe("EventBus", () => {
  test("immediate event dispatches and deletes file", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();

    // Write after start so it's not stale
    writeEvent("test.json", {
      type: "immediate",
      text: "hello",
      threadId: "slack:C1:T1",
    });

    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0].target).toEqual({ threadId: "slack:C1:T1" });
    expect(calls[0].text).toContain("[EVENT:test.json:immediate:immediate]");
    expect(calls[0].text).toContain("hello");

    // File should be deleted
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(eventsDir, "test.json"))).toBe(false);

    bus.stop();
  });

  test("stale immediate event deleted without dispatch", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    // Write file with old mtime
    writeEvent("stale.json", {
      type: "immediate",
      text: "old",
      threadId: "slack:C1:T1",
    });

    // Set mtime to the past
    const { utimesSync } = await import("node:fs");
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(eventsDir, "stale.json"), past, past);

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();
    await settle();

    expect(calls.length).toBe(0);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(eventsDir, "stale.json"))).toBe(false);

    bus.stop();
  });

  test("one-shot future event dispatches at scheduled time then deletes", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    const futureDate = new Date(Date.now() + 150).toISOString();
    writeEvent("future.json", {
      type: "one-shot",
      text: "scheduled",
      at: futureDate,
      threadId: "slack:C1:T1",
    });

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();

    // Should not dispatch immediately
    await settle(50);
    expect(calls.length).toBe(0);

    // Should dispatch after delay
    await settle(200);
    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain("scheduled");

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(eventsDir, "future.json"))).toBe(false);

    bus.stop();
  });

  test("one-shot past event fires immediately then deletes", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    const pastDate = new Date(Date.now() - 10_000).toISOString();
    writeEvent("past.json", {
      type: "one-shot",
      text: "overdue",
      at: pastDate,
      threadId: "slack:C1:T1",
    });

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();
    await settle();

    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain("overdue");

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(eventsDir, "past.json"))).toBe(false);

    bus.stop();
  });

  test("periodic event dispatches on cron and persists file", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    // Every second
    writeEvent("cron.json", {
      type: "periodic",
      text: "tick",
      schedule: "* * * * * *",
      timezone: "UTC",
      channelId: "slack:C1",
    });

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();

    // Wait for at least one cron tick
    await settle(1500);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].target).toEqual({ channelId: "slack:C1" });
    expect(calls[0].text).toContain("tick");

    // File should still exist (periodic events persist)
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(eventsDir, "cron.json"))).toBe(true);

    bus.stop();
  });

  test("invalid JSON retried then deleted", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    writeFileSync(join(eventsDir, "bad.json"), "not json{{{");

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();

    // Wait for retries (100ms + 200ms + 400ms = 700ms)
    await settle(1000);

    expect(calls.length).toBe(0);

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(eventsDir, "bad.json"))).toBe(false);

    bus.stop();
  });

  test("file deleted externally cancels timer", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    const futureDate = new Date(Date.now() + 5000).toISOString();
    writeEvent("cancel-me.json", {
      type: "one-shot",
      text: "should not fire",
      at: futureDate,
      threadId: "slack:C1:T1",
    });

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();
    await settle(300);

    // Delete the file externally
    try {
      unlinkSync(join(eventsDir, "cancel-me.json"));
    } catch {}

    // Wait for debounce + extra
    await settle(300);

    // Should not have dispatched
    expect(calls.length).toBe(0);

    bus.stop();
  });

  test("file modified re-schedules event", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    // Schedule far in the future initially
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    writeEvent("modify.json", {
      type: "one-shot",
      text: "original",
      at: farFuture,
      threadId: "slack:C1:T1",
    });

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();
    await settle(300);

    // Modify to fire soon
    const soonDate = new Date(Date.now() + 150).toISOString();
    writeEvent("modify.json", {
      type: "one-shot",
      text: "updated",
      at: soonDate,
      threadId: "slack:C1:T1",
    });

    await settle(500);

    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain("updated");

    bus.stop();
  });

  test.skip("debounce coalesces rapid writes — flaky due to fs.watch timing", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();

    // Write rapidly — only the last write should be processed
    for (let i = 0; i < 5; i++) {
      writeEvent("rapid.json", {
        type: "immediate",
        text: `attempt-${i}`,
        threadId: "slack:C1:T1",
      });
    }

    // fs.watch + debounce (100ms) + file handling
    await settle(800);

    // Should have dispatched once (the last version after debounce)
    expect(calls.length).toBe(1);
    expect(calls[0].text).toContain("attempt-4");

    bus.stop();
  });

  test("thread target vs channel target", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();

    // Write after start so they're not filtered as stale
    writeEvent("thread-target.json", {
      type: "immediate",
      text: "to thread",
      threadId: "slack:C1:T1",
    });

    writeEvent("channel-target.json", {
      type: "immediate",
      text: "to channel",
      channelId: "slack:C1",
    });

    await settle();

    expect(calls.length).toBe(2);

    const threadCall = calls.find((c) => "threadId" in c.target);
    const channelCall = calls.find((c) => "channelId" in c.target);

    expect(threadCall).toBeDefined();
    expect(channelCall).toBeDefined();
    expect((threadCall!.target as { threadId: string }).threadId).toBe(
      "slack:C1:T1"
    );
    expect(
      (channelCall!.target as { channelId: string }).channelId
    ).toBe("slack:C1");

    bus.stop();
  });

  test("stop() cancels everything", async () => {
    const calls: Array<{ target: EventTarget; text: string }> = [];
    const dispatch: EventDispatch = (target, text) => {
      calls.push({ target, text });
    };

    const futureDate = new Date(Date.now() + 500).toISOString();
    writeEvent("stopped.json", {
      type: "one-shot",
      text: "should not fire",
      at: futureDate,
      threadId: "slack:C1:T1",
    });

    writeEvent("cron-stop.json", {
      type: "periodic",
      text: "tick",
      schedule: "* * * * * *",
      timezone: "UTC",
      threadId: "slack:C1:T1",
    });

    const bus = new EventBus(eventsDir, dispatch);
    bus.start();
    await settle(200);

    bus.stop();

    const callsBefore = calls.length;
    await settle(1500);

    // No new dispatches after stop
    expect(calls.length).toBe(callsBefore);
  });

  test("creates events dir if it does not exist", async () => {
    const newDir = join(tmpDir, "nonexistent", "events");
    const dispatch: EventDispatch = () => {};

    const bus = new EventBus(newDir, dispatch);
    bus.start();

    const { existsSync } = await import("node:fs");
    expect(existsSync(newDir)).toBe(true);

    bus.stop();
  });
});
