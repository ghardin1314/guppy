import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { SentMessage, Thread } from "chat";
import { Orchestrator } from "../src/orchestrator";
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

let dataDir: string;
let store: Store;
let factoryCallIds: string[];
let agentFactory: (id: string) => Agent;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-orch-"));
  store = new Store({ dataDir });
  factoryCallIds = [];
  agentFactory = (id: string) => {
    factoryCallIds.push(id);
    return createMockAgent();
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Orchestrator", () => {
  test("creates actor on demand per threadId", async () => {
    const orch = new Orchestrator({ store, agentFactory });
    const thread = createMockThread();

    orch.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    await new Promise((r) => setTimeout(r, 20));

    expect(factoryCallIds).toEqual(["slack:C1:T1"]);
  });

  test("routes same threadId to same actor", async () => {
    const orch = new Orchestrator({ store, agentFactory });
    const thread = createMockThread();

    orch.send("slack:C1:T1", { type: "prompt", text: "first", thread });
    await new Promise((r) => setTimeout(r, 20));
    orch.send("slack:C1:T1", { type: "prompt", text: "second", thread });
    await new Promise((r) => setTimeout(r, 20));

    // Factory only called once — same actor reused
    expect(factoryCallIds).toEqual(["slack:C1:T1"]);
  });

  test("different threadIds create different actors", async () => {
    const orch = new Orchestrator({ store, agentFactory });
    const thread = createMockThread();

    orch.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    orch.send("slack:C1:T2", { type: "prompt", text: "hi", thread });
    await new Promise((r) => setTimeout(r, 20));

    expect(factoryCallIds).toEqual(["slack:C1:T1", "slack:C1:T2"]);
  });

  test("shutdown destroys all actors", async () => {
    const agents: Agent[] = [];
    const factory = (id: string) => {
      const a = createMockAgent();
      agents.push(a);
      return a;
    };

    const orch = new Orchestrator({ store, agentFactory: factory });
    const thread = createMockThread();

    orch.send("slack:C1:T1", { type: "prompt", text: "hi", thread });
    orch.send("slack:C1:T2", { type: "prompt", text: "hi", thread });
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
      settings: customSettings,
    });
    orch.shutdown();
  });
});
