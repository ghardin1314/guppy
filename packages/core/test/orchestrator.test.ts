import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { SentMessage, Thread } from "chat";
import { Orchestrator, type ChatHandle } from "../src/orchestrator";
import { Store } from "../src/store";

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

function createMockSentMessage(): SentMessage {
  const makeMock = (): SentMessage =>
    ({
      id: `msg-${Date.now()}`,
      text: "",
      edit: mock(async () => makeMock()),
      delete: mock(async () => {}),
      addReaction: mock(async () => {}),
      removeReaction: mock(async () => {}),
    }) as unknown as SentMessage;
  return makeMock();
}

function createMockThread(id = "thread-1"): Thread {
  return {
    id,
    channelId: "channel-1",
    isDM: false,
    recentMessages: [],
    post: mock(async () => createMockSentMessage()),
    startTyping: mock(async () => {}),
  } as unknown as Thread;
}

function createMockChat(): ChatHandle {
  return {
    channel() {
      return { async post() { return { threadId: "mock-thread" }; } };
    },
  };
}

let dataDir: string;
let store: Store;
let chat: ChatHandle;
let factoryCallIds: string[];
let agentFactory: (thread: Thread) => Agent;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-orch-"));
  store = new Store({ dataDir });
  chat = createMockChat();
  factoryCallIds = [];
  agentFactory = (thread: Thread) => {
    factoryCallIds.push(thread.id);
    return createMockAgent();
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Orchestrator", () => {
  test("creates actor on demand per threadId", async () => {
    const orch = new Orchestrator({ store, agentFactory, chat, settings: {} });
    const thread = createMockThread("slack:C1:T1");

    orch.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    await new Promise((r) => setTimeout(r, 20));

    expect(factoryCallIds).toEqual(["slack:C1:T1"]);
  });

  test("routes same threadId to same actor", async () => {
    const orch = new Orchestrator({ store, agentFactory, chat, settings: {} });
    const thread = createMockThread("slack:C1:T1");

    orch.send("slack:C1:T1", { type: "prompt", text: "first", thread });
    await new Promise((r) => setTimeout(r, 20));
    orch.send("slack:C1:T1", { type: "prompt", text: "second", thread });
    await new Promise((r) => setTimeout(r, 20));

    // Factory only called once — same actor reused
    expect(factoryCallIds).toEqual(["slack:C1:T1"]);
  });

  test("different threadIds create different actors", async () => {
    const orch = new Orchestrator({ store, agentFactory, chat, settings: {} });
    const thread1 = createMockThread("slack:C1:T1");
    const thread2 = createMockThread("slack:C1:T2");

    orch.send("slack:C1:T1", { type: "prompt", text: "hi", thread: thread1 });
    orch.send("slack:C1:T2", { type: "prompt", text: "hi", thread: thread2 });
    await new Promise((r) => setTimeout(r, 20));

    expect(factoryCallIds).toEqual(["slack:C1:T1", "slack:C1:T2"]);
  });

  test("shutdown destroys all actors", async () => {
    const agents: Agent[] = [];
    const factory = (thread: Thread) => {
      const a = createMockAgent();
      agents.push(a);
      return a;
    };

    const orch = new Orchestrator({ store, agentFactory: factory, chat, settings: {} });

    orch.send("slack:C1:T1", { type: "prompt", text: "hi", thread: createMockThread("slack:C1:T1") });
    orch.send("slack:C1:T2", { type: "prompt", text: "hi", thread: createMockThread("slack:C1:T2") });
    await new Promise((r) => setTimeout(r, 20));

    orch.shutdown();

    // Both agents should have been aborted
    for (const a of agents) {
      expect(a.abort).toHaveBeenCalled();
    }
  });

  test("uses provided settings over store settings", () => {
    const customSettings = { idleTimeoutMs: 1000 };
    // Should not throw
    const orch = new Orchestrator({
      store,
      agentFactory,
      chat,
      settings: customSettings,
    });
    orch.shutdown();
  });

  describe("sendToChannel", () => {
    test("posts to channel via chat and routes to actor", async () => {
      let postCalled = false;
      let postedText = "";

      const mockChat: ChatHandle = {
        channel(channelId: string) {
          return {
            async post(text: string) {
              postCalled = true;
              postedText = text;
              return { threadId: `slack:${channelId}:T-new` };
            },
          };
        },
      };

      const orch = new Orchestrator({ store, agentFactory, chat: mockChat, settings: {} });
      orch.sendToChannel("slack", "C1", "hello channel");

      await new Promise((r) => setTimeout(r, 50));

      expect(postCalled).toBe(true);
      expect(postedText).toBe("hello channel");
      // Should have routed to an actor
      expect(factoryCallIds).toContain("slack:slack:C1:T-new");

      orch.shutdown();
    });

    test("logs error when channel.post fails", async () => {
      const errorCalls: unknown[][] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errorCalls.push(args);

      try {
        const mockChat: ChatHandle = {
          channel() {
            return {
              async post() {
                throw new Error("network failure");
              },
            };
          },
        };

        const orch = new Orchestrator({
          store,
          agentFactory,
          chat: mockChat,
          settings: {},
        });
        orch.sendToChannel("slack", "C1", "hello");

        await new Promise((r) => setTimeout(r, 50));

        expect(
          errorCalls.some((args) =>
            String(args[0]).includes("sendToChannel failed")
          )
        ).toBe(true);

        orch.shutdown();
      } finally {
        console.error = originalError;
      }
    });
  });
});
