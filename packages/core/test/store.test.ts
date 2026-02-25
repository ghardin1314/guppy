import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Message } from "chat";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Store } from "../src/store";

function makeMessage(
  id: string,
  text: string,
  overrides?: {
    isBot?: boolean;
    isMe?: boolean;
    attachments?: Message["attachments"];
  }
): Message {
  return new Message({
    id,
    threadId: "slack:C123:1234.5678",
    text,
    formatted: { type: "root", children: [] },
    raw: {},
    author: {
      userId: "U123",
      userName: "testuser",
      fullName: "Test User",
      isBot: overrides?.isBot ?? false,
      isMe: overrides?.isMe ?? false,
    },
    metadata: {
      dateSent: new Date("2024-01-15T10:30:00.000Z"),
      edited: false,
    },
    attachments: overrides?.attachments ?? [],
  });
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-store-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const THREAD_ID = "slack:C123ABC:1234567890.123456";

describe("path resolution", () => {
  test("threadDir builds correct path", () => {
    const store = new Store({ dataDir });
    expect(store.threadDir(THREAD_ID)).toBe(
      join(dataDir, "slack", "C123ABC", "1234567890.123456")
    );
  });

  test("channelDir builds correct path", () => {
    const store = new Store({ dataDir });
    expect(store.channelDir(THREAD_ID)).toBe(
      join(dataDir, "slack", "C123ABC")
    );
  });

  test("transportDir builds correct path", () => {
    const store = new Store({ dataDir });
    expect(store.transportDir(THREAD_ID)).toBe(join(dataDir, "slack"));
  });

  test("encodes Google Chat-style IDs with slashes", () => {
    const store = new Store({ dataDir });
    const gchatId = "gchat:spaces/ABC123:threads/xyz";
    expect(store.threadDir(gchatId)).toBe(
      join(dataDir, "gchat", "spaces%2FABC123", "threads%2Fxyz")
    );
  });
});

describe("logMessage", () => {
  test("appends JSONL entry to log.jsonl", () => {
    const store = new Store({ dataDir });
    const msg = makeMessage("msg-1", "Hello world");
    store.logMessage(THREAD_ID, msg);

    const logPath = join(store.threadDir(THREAD_ID), "log.jsonl");
    const content = readFileSync(logPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.messageId).toBe("msg-1");
    expect(entry.text).toBe("Hello world");
    expect(entry.userId).toBe("U123");
    expect(entry.userName).toBe("Test User");
    expect(entry.isBot).toBe(false);
    expect(entry.date).toBe("2024-01-15T10:30:00.000Z");
  });

  test("marks bot messages correctly", () => {
    const store = new Store({ dataDir });
    store.logMessage(THREAD_ID, makeMessage("b1", "Bot msg", { isBot: true }));
    store.logMessage(THREAD_ID, makeMessage("b2", "Me msg", { isMe: true }));

    const lines = readFileSync(join(store.threadDir(THREAD_ID), "log.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(lines[0].isBot).toBe(true);
    expect(lines[1].isBot).toBe(true);
  });

  test("appends multiple messages", () => {
    const store = new Store({ dataDir });
    store.logMessage(THREAD_ID, makeMessage("m1", "First"));
    store.logMessage(THREAD_ID, makeMessage("m2", "Second"));

    const lines = readFileSync(join(store.threadDir(THREAD_ID), "log.jsonl"), "utf-8")
      .trim()
      .split("\n");

    expect(lines).toHaveLength(2);
  });
});

describe("context save/load", () => {
  test("round-trips context messages", () => {
    const store = new Store({ dataDir });
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-3",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    ];

    store.saveContext(THREAD_ID, messages);
    const loaded = store.loadContext(THREAD_ID);

    expect(loaded).toHaveLength(2);
    expect(loaded[0].role).toBe("user");
    expect(loaded[1].role).toBe("assistant");
  });

  test("returns empty array for missing context", () => {
    const store = new Store({ dataDir });
    expect(store.loadContext(THREAD_ID)).toEqual([]);
  });

  test("saveContext uses atomic write (no .tmp file left behind)", () => {
    const store = new Store({ dataDir });
    const messages: AgentMessage[] = [
      { role: "user", content: "Hello", timestamp: Date.now() },
    ];

    store.saveContext(THREAD_ID, messages);

    const dir = store.threadDir(THREAD_ID);
    expect(existsSync(join(dir, "context.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "context.jsonl.tmp"))).toBe(false);
  });

  test("saveContext preserves original on simulated partial write", () => {
    const store = new Store({ dataDir });
    const original: AgentMessage[] = [
      { role: "user", content: "Original", timestamp: 1 },
    ];
    store.saveContext(THREAD_ID, original);

    // Simulate a crash that left a .tmp file but never renamed
    const dir = store.threadDir(THREAD_ID);
    writeFileSync(join(dir, "context.jsonl.tmp"), "corrupt partial data");

    // loadContext should still read the intact original
    const loaded = store.loadContext(THREAD_ID);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { content: string }).content).toBe("Original");
  });

  test("saveContext overwrites existing file", () => {
    const store = new Store({ dataDir });
    const first: AgentMessage[] = [
      { role: "user", content: "First", timestamp: 1 },
    ];
    const second: AgentMessage[] = [
      { role: "user", content: "Second", timestamp: 2 },
    ];

    store.saveContext(THREAD_ID, first);
    store.saveContext(THREAD_ID, second);

    const loaded = store.loadContext(THREAD_ID);
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as { content: string }).content).toBe("Second");
  });
});

describe("getSettings", () => {
  test("returns parsed settings", () => {
    const store = new Store({ dataDir });
    const settings = { defaultModel: "claude-3", idleTimeoutMs: 5000 };
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(settings));

    expect(store.getSettings()).toEqual(settings);
  });

  test("returns empty object for missing file", () => {
    const store = new Store({ dataDir });
    expect(store.getSettings()).toEqual({});
  });

  test("returns empty object for invalid JSON", () => {
    const store = new Store({ dataDir });
    writeFileSync(join(dataDir, "settings.json"), "not json{{{");
    expect(store.getSettings()).toEqual({});
  });
});

describe("downloadAttachment", () => {
  test("downloads file and returns relative path", async () => {
    const store = new Store({ dataDir });

    // Create a simple test server URL isn't feasible in unit tests,
    // so we test with a data URL workaround using fetch mock
    const dir = store.threadDir(THREAD_ID);
    mkdirSync(join(dir, "attachments"), { recursive: true });

    // Just verify the sanitization and path building
    const result = await store.downloadAttachment(
      THREAD_ID,
      "https://httpbin.org/bytes/4",
      "test file (1).txt"
    );

    expect(result).toMatch(/^attachments\/\d+_test_file__1_.txt$/);
  });
});
