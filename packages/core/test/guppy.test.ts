import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Thread } from "chat";
import { Guppy } from "../src/guppy";
import type { ChatHandle } from "../src/orchestrator";

function createMockAgent() {
  let listeners: ((e: AgentEvent) => void)[] = [];
  let messages: AgentMessage[] = [];

  return {
    get state() {
      return { messages };
    },
    replaceMessages(ms: AgentMessage[]) {
      messages = ms;
    },
    subscribe(fn: (e: AgentEvent) => void) {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    prompt: mock(() => {}),
    waitForIdle: mock(async () => {}),
    steer: mock(() => {}),
    abort: mock(() => {}),
  } as unknown as Agent;
}

function createMockThread(id = "thread-1"): Thread {
  return {
    id,
    channelId: "channel-1",
    isDM: false,
    recentMessages: [],
    post: mock(async () => ({
      id: `msg-${Date.now()}`,
      text: "",
      edit: mock(async () => ({})),
      delete: mock(async () => {}),
      addReaction: mock(async () => {}),
      removeReaction: mock(async () => {}),
    })),
    startTyping: mock(async () => {}),
  } as unknown as Thread;
}

function createMockChat(): ChatHandle {
  return {
    channel() {
      return {
        async post() {
          return { threadId: "mock-thread" };
        },
      };
    },
    getAdapter: (name: string) => ({ name }) as never,
    getState: () => ({}) as never,
  };
}

let dataDir: string;
let factoryCallIds: string[];
let agentFactory: (thread: Thread) => Agent;
let chat: ChatHandle;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-glue-"));
  factoryCallIds = [];
  agentFactory = (thread: Thread) => {
    factoryCallIds.push(thread.id);
    return createMockAgent();
  };
  chat = createMockChat();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Guppy", () => {
  test("constructor creates store, orchestrator, and eventBus", () => {
    const guppy = new Guppy({
      dataDir,
      agentFactory,
      settings: {},
      chat,
    });

    expect(guppy.store).toBeDefined();
    expect(guppy.orchestrator).toBeDefined();
    expect(guppy.eventBus).toBeDefined();
    expect(guppy.store.dataDir).toBe(dataDir);

    guppy.shutdown();
  });

  test("send() delegates to orchestrator", async () => {
    const guppy = new Guppy({
      dataDir,
      agentFactory,
      settings: {},
      chat,
    });

    const thread = createMockThread("slack:C1:T1");
    guppy.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    await new Promise((r) => setTimeout(r, 20));

    expect(factoryCallIds).toEqual(["slack:C1:T1"]);

    guppy.shutdown();
  });

  test("sendToChannel() delegates to orchestrator", async () => {
    let postCalled = false;

    const mockChat: ChatHandle = {
      channel() {
        return {
          async post(text: string) {
            postCalled = true;
            return { threadId: "mock-thread" };
          },
        };
      },
      getAdapter: (name: string) => ({ name }) as never,
      getState: () => ({}) as never,
    };

    const guppy = new Guppy({
      dataDir,
      agentFactory,
      settings: {},
      chat: mockChat,
    });

    guppy.sendToChannel("slack:C1", "hello");
    await new Promise((r) => setTimeout(r, 50));

    expect(postCalled).toBe(true);

    guppy.shutdown();
  });

  test("shutdown() stops eventBus and orchestrator", async () => {
    const agents: Agent[] = [];
    const factory = (thread: Thread) => {
      const a = createMockAgent();
      agents.push(a);
      return a;
    };

    const guppy = new Guppy({
      dataDir,
      agentFactory: factory,
      settings: {},
      chat,
    });

    const thread = createMockThread("slack:C1:T1");
    guppy.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    await new Promise((r) => setTimeout(r, 20));

    guppy.shutdown();

    for (const a of agents) {
      expect(a.abort).toHaveBeenCalled();
    }

    // Calling shutdown again should not throw
    guppy.shutdown();
  });

  test("shutdown() is idempotent", () => {
    const guppy = new Guppy({
      dataDir,
      agentFactory,
      settings: {},
      chat,
    });

    // Should not throw
    guppy.shutdown();
    guppy.shutdown();
  });
});
