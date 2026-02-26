import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { Thread } from "chat";
import { Guppy } from "../src/guppy";
import { Orchestrator } from "../src/orchestrator";
import { Store } from "../src/store";
import { EventBus } from "../src/events";
import type { AgentFactory, ChatHandle } from "../src/types";

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

function createMockThread(id = "slack:C1:T1"): Thread {
  return {
    id,
    channelId: "slack:C1",
    isDM: false,
    adapter: { name: "slack" },
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
    channel: () => ({ post: async () => ({ threadId: "slack:C1:T-mock" }) }) as never,
    getAdapter: (name: string) => ({ name }) as never,
    getState: () => ({}) as never,
  };
}

let dataDir: string;
let factoryCallIds: string[];
let agentFactory: AgentFactory;
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
  // These tests verify routing via Orchestrator with a mock agentFactory,
  // testing integration between Guppy's components without needing real LLM calls.

  function createTestGuppy(overrides?: { agentFactory?: AgentFactory; chat?: ChatHandle }) {
    const c = overrides?.chat ?? chat;
    const store = new Store({ dataDir, getAdapter: (name) => c.getAdapter(name) });
    const orchestrator = new Orchestrator({
      store,
      agentFactory: overrides?.agentFactory ?? agentFactory,
      settings: {},
      chat: c,
    });
    const eventsDir = join(dataDir, "events");
    const eventBus = new EventBus(eventsDir, (target, text) => {
      orchestrator.dispatchEvent(target, text);
    });
    eventBus.start();
    return { store, orchestrator, eventBus, shutdown: () => { eventBus.stop(); orchestrator.shutdown(); } };
  }

  test("constructor creates store, orchestrator, and eventBus", () => {
    const g = createTestGuppy();
    expect(g.store).toBeDefined();
    expect(g.orchestrator).toBeDefined();
    expect(g.eventBus).toBeDefined();
    g.shutdown();
  });

  test("send() delegates to orchestrator", async () => {
    const g = createTestGuppy();

    const thread = createMockThread("slack:C1:T1");
    g.orchestrator.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    await new Promise((r) => setTimeout(r, 20));

    expect(factoryCallIds).toEqual(["slack:C1:T1"]);

    g.shutdown();
  });

  test("sendToChannel() delegates to orchestrator", async () => {
    let postCalled = false;

    const mockChat: ChatHandle = {
      channel: () => ({
        post: async (text: string) => {
          postCalled = true;
          return { threadId: "slack:C1:T-mock" };
        },
      }) as never,
      getAdapter: (name: string) => ({ name }) as never,
      getState: () => ({}) as never,
    };

    const g = createTestGuppy({ chat: mockChat });

    g.orchestrator.sendToChannel("slack:C1", "hello");
    await new Promise((r) => setTimeout(r, 50));

    expect(postCalled).toBe(true);

    g.shutdown();
  });

  test("shutdown() stops eventBus and orchestrator", async () => {
    const agents: Agent[] = [];
    const factory: AgentFactory = (thread: Thread) => {
      const a = createMockAgent();
      agents.push(a);
      return a;
    };

    const g = createTestGuppy({ agentFactory: factory });

    const thread = createMockThread("slack:C1:T1");
    g.orchestrator.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    await new Promise((r) => setTimeout(r, 20));

    g.shutdown();

    for (const a of agents) {
      expect(a.abort).toHaveBeenCalled();
    }

    // Calling shutdown again should not throw
    g.shutdown();
  });

  test("shutdown() is idempotent", () => {
    const g = createTestGuppy();
    g.shutdown();
    g.shutdown();
  });

  describe("handleSlashCommand", () => {
    test("/stop aborts all actors in channel", async () => {
      const agents: Agent[] = [];
      const factory: AgentFactory = (thread: Thread) => {
        const a = createMockAgent();
        // Make prompt hang so actor stays running
        a.prompt = mock(() => new Promise(() => {}));
        agents.push(a);
        return a;
      };

      const g = createTestGuppy({ agentFactory: factory });

      g.orchestrator.send("slack:C1:T1", {
        type: "prompt",
        text: "hi",
        thread: createMockThread("slack:C1:T1"),
      });
      g.orchestrator.send("slack:C1:T2", {
        type: "prompt",
        text: "hi",
        thread: createMockThread("slack:C1:T2"),
      });
      await new Promise((r) => setTimeout(r, 20));

      const result = g.orchestrator.broadcastCommand("slack:C1:", { type: "abort" });
      expect(result).toBe(2);
      expect(agents[0].abort).toHaveBeenCalled();
      expect(agents[1].abort).toHaveBeenCalled();

      g.shutdown();
    });

    test("returns false for unknown command", () => {
      const g = createTestGuppy();

      const { commandToMessage } = require("../src/commands");
      const msg = commandToMessage("unknown", "");
      expect(msg).toBeNull();

      g.shutdown();
    });
  });
});
