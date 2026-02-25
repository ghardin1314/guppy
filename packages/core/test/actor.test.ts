import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
} from "@mariozechner/pi-agent-core";
import type { SentMessage, Thread } from "chat";
import { Actor } from "../src/actor";
import { Store } from "../src/store";

// --- Helpers ---

type EventListener = (e: AgentEvent) => void;

function createMockAgent() {
  let listeners: EventListener[] = [];
  let messages: AgentMessage[] = [];

  const agent = {
    get state() {
      return { messages };
    },
    replaceMessages(ms: AgentMessage[]) {
      messages = [...ms];
    },
    subscribe(fn: EventListener) {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    },
    prompt: mock((_input: string | AgentMessage | AgentMessage[]) => {
      // Default: emit agent_start, tool_execution_start, then message_end
      for (const l of [...listeners]) {
        l({ type: "agent_start" });
      }
      for (const l of [...listeners]) {
        l({
          type: "tool_execution_start",
          toolCallId: "tc-1",
          toolName: "bash",
          args: {},
        });
      }
      const assistantMsg: AgentMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Hello from agent" }],
        api: "anthropic",
        provider: "anthropic",
        model: "claude-3",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      messages.push(assistantMsg);
      for (const l of [...listeners]) {
        l({ type: "message_end", message: assistantMsg });
      }
    }),
    waitForIdle: mock(async () => {}),
    steer: mock((_m: AgentMessage) => {}),
    abort: mock(() => {}),
    // Test helpers
    _emit(e: AgentEvent) {
      for (const l of [...listeners]) l(e);
    },
  };

  return agent;
}

/**
 * Creates a mock SentMessage that tracks all edits in the shared `edits` array.
 * Each edit returns a new mock that also tracks into the same array.
 */
function createTrackingSentMessage(
  initialText: string,
  edits: string[]
): SentMessage {
  const makeMock = (t: string): SentMessage =>
    ({
      id: `msg-${Date.now()}`,
      text: t,
      edit: mock(async (newContent: string) => {
        edits.push(newContent);
        return makeMock(newContent);
      }),
      delete: mock(async () => {}),
      addReaction: mock(async () => {}),
      removeReaction: mock(async () => {}),
    }) as unknown as SentMessage;
  return makeMock(initialText);
}

function createMockThread(): Thread & { _posts: string[]; _edits: string[] } {
  const posts: string[] = [];
  const edits: string[] = [];
  const thread = {
    _posts: posts,
    _edits: edits,
    post: mock(async (message: string) => {
      posts.push(message);
      return createTrackingSentMessage(message, edits);
    }),
    startTyping: mock(async () => {}),
    id: "thread-1",
    channelId: "channel-1",
    isDM: false,
    recentMessages: [],
  } as unknown as Thread & { _posts: string[]; _edits: string[] };
  return thread;
}

let dataDir: string;
let store: Store;
let mockAgent: ReturnType<typeof createMockAgent>;
let agentFactory: ReturnType<typeof mock>;

const THREAD_ID = "slack:C123:1234.5678";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-actor-"));
  store = new Store({ dataDir });
  mockAgent = createMockAgent();
  agentFactory = mock(() => mockAgent as unknown as Agent);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function createActor(settings = {}) {
  return new Actor(THREAD_ID, {
    store,
    agentFactory: agentFactory as unknown as (id: string) => Agent,
    settings,
  });
}

/** Wait for async drain + message chain to settle */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// --- Tests ---

describe("Actor", () => {
  test("lazy activation — factory not called until first prompt", () => {
    createActor();
    expect(agentFactory).not.toHaveBeenCalled();
  });

  test("prompt triggers agent creation and prompt call", async () => {
    const actor = createActor();
    const thread = createMockThread();

    actor.receive({ type: "prompt", text: "hi", thread });
    await settle();

    expect(agentFactory).toHaveBeenCalledTimes(1);
    expect(mockAgent.prompt).toHaveBeenCalledTimes(1);
  });

  test("sequential drain — prompts run in order", async () => {
    const order: number[] = [];
    let callCount = 0;
    mockAgent.prompt = mock(
      (_input: string | AgentMessage | AgentMessage[]) => {
        order.push(++callCount);
      }
    );

    const actor = createActor();
    const thread = createMockThread();

    actor.receive({ type: "prompt", text: "first", thread });
    actor.receive({ type: "prompt", text: "second", thread });
    await settle();

    expect(order).toEqual([1, 2]);
  });

  test("queue backpressure — rejects when queue full", async () => {
    // Make prompt block so queue fills up
    mockAgent.prompt = mock(
      async () => new Promise<void>((r) => setTimeout(r, 500))
    );

    const actor = createActor({ maxQueueDepth: 2 });
    const thread = createMockThread();

    // First prompt starts draining
    actor.receive({ type: "prompt", text: "running", thread });
    await settle(5);

    // Fill queue
    actor.receive({ type: "prompt", text: "queued-1", thread });
    actor.receive({ type: "prompt", text: "queued-2", thread });

    // Overflow
    actor.receive({ type: "prompt", text: "overflow", thread });

    expect(thread._posts).toContain(
      "Too many queued messages — please wait."
    );
  });

  test("steer mid-run calls agent.steer", async () => {
    mockAgent.prompt = mock(
      async () => new Promise<void>((r) => setTimeout(r, 100))
    );

    const actor = createActor();
    const thread = createMockThread();

    actor.receive({ type: "prompt", text: "work", thread });
    await settle(10);

    actor.receive({ type: "steer", text: "change direction" });
    expect(mockAgent.steer).toHaveBeenCalledTimes(1);
  });

  test("steer when idle — no-op", () => {
    const actor = createActor();
    actor.receive({ type: "steer", text: "ignored" });
    expect(mockAgent.steer).not.toHaveBeenCalled();
  });

  test("abort mid-run calls agent.abort", async () => {
    mockAgent.prompt = mock(
      async () => new Promise<void>((r) => setTimeout(r, 100))
    );

    const actor = createActor();
    const thread = createMockThread();

    actor.receive({ type: "prompt", text: "work", thread });
    await settle(10);

    actor.receive({ type: "abort" });
    expect(mockAgent.abort).toHaveBeenCalledTimes(1);
  });

  test("error recovery — error shown via edit, next prompt still runs", async () => {
    let callNum = 0;
    mockAgent.prompt = mock(
      (_input: string | AgentMessage | AgentMessage[]) => {
        if (++callNum === 1) throw new Error("LLM failed");
      }
    );

    const actor = createActor();
    const thread = createMockThread();

    actor.receive({ type: "prompt", text: "fail", thread });
    actor.receive({ type: "prompt", text: "succeed", thread });
    await settle();

    // Error should appear either in a post or an edit
    const allText = [...thread._posts, ...thread._edits];
    const hasError = allText.some((t) => t.includes("Error: LLM failed"));
    expect(hasError).toBe(true);
    expect(mockAgent.prompt).toHaveBeenCalledTimes(2);
  });

  test("context load/save round-trip", async () => {
    const saved: AgentMessage[] = [
      { role: "user", content: "previous", timestamp: 1 },
    ];
    store.saveContext(THREAD_ID, saved);

    const actor = createActor();
    const thread = createMockThread();

    actor.receive({ type: "prompt", text: "new msg", thread });
    await settle();

    const loaded = store.loadContext(THREAD_ID);
    expect(loaded.length).toBeGreaterThan(0);
  });

  describe("single evolving message UX", () => {
    test("posts initial 'Thinking' message with working indicator", async () => {
      mockAgent.prompt = mock(() => {
        mockAgent._emit({ type: "agent_start" });
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      expect(thread._posts[0]).toMatch(/^_Thinking_/);
      expect(thread._posts[0]).toContain("…");
    });

    test("tool_execution_start appends tool label via edit", async () => {
      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const hasToolLabel = thread._edits.some((e) => e.includes("→ bash"));
      expect(hasToolLabel).toBe(true);
    });

    test("final edit replaces with agent response text, no indicator", async () => {
      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const lastEdit = thread._edits[thread._edits.length - 1];
      expect(lastEdit).toBe("Hello from agent");
      expect(lastEdit).not.toContain("…");
      expect(lastEdit).not.toContain("Thinking");
    });

    test("tool_execution_end error appends error text", async () => {
      mockAgent.prompt = mock(() => {
        mockAgent._emit({ type: "agent_start" });
        mockAgent._emit({
          type: "tool_execution_end",
          toolCallId: "tc-1",
          toolName: "bash",
          result: "command not found",
          isError: true,
        });
        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Fix applied" }],
          api: "anthropic",
          provider: "anthropic",
          model: "claude-3",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        };
        // Push into state.messages so extractFinalText finds it
        mockAgent.state.messages.push(assistantMsg);
        mockAgent._emit({ type: "message_end", message: assistantMsg });
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const hasError = thread._edits.some((e) =>
        e.includes("Error: command not found")
      );
      expect(hasError).toBe(true);

      // Final edit should still be the response text
      const lastEdit = thread._edits[thread._edits.length - 1];
      expect(lastEdit).toBe("Fix applied");
    });

    test("status shows working indicator, final does not", async () => {
      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      // All edits except the last should have the indicator
      const statusEdits = thread._edits.slice(0, -1);
      for (const e of statusEdits) {
        expect(e).toContain("…");
      }
      // Last edit (final) should not
      expect(thread._edits[thread._edits.length - 1]).not.toContain("…");
    });
  });

  test("destroy aborts agent", async () => {
    mockAgent.prompt = mock(
      async () => new Promise<void>((r) => setTimeout(r, 200))
    );

    const actor = createActor();
    const thread = createMockThread();

    actor.receive({ type: "prompt", text: "work", thread });
    await settle(10);

    actor.destroy();
    expect(mockAgent.abort).toHaveBeenCalled();
  });
});
