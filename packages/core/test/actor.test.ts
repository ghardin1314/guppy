import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
} from "@mariozechner/pi-agent-core";
import { RateLimitError } from "chat";
import type { SentMessage, Thread } from "chat";
import { Actor, describeError, isTransportRetryable } from "../src/actor";
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
  store = new Store({ dataDir, getAdapter: (name) => ({ name }) });
  mockAgent = createMockAgent();
  agentFactory = mock(() => mockAgent as unknown as Agent);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function createActor(settings = {}) {
  return new Actor(THREAD_ID, {
    store,
    agentFactory: agentFactory as unknown as (thread: Thread) => Agent,
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

    // Descriptive error should appear in a post or edit
    const allText = [...thread._posts, ...thread._edits];
    const hasError = allText.some((t) =>
      t.includes("Something went wrong: LLM failed")
    );
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

  test("[SILENT] response deletes message instead of posting", async () => {
      mockAgent.prompt = mock(() => {
        for (const l of []) {} // no events needed
        mockAgent._emit({ type: "agent_start" });
        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: [{ type: "text", text: "[SILENT]" }],
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
        mockAgent.state.messages.push(assistantMsg);
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "periodic check", thread });
      await settle();

      // "Thinking" was posted, then deleted — no final text edit
      expect(thread._posts.length).toBe(1); // initial "Thinking" post
      const lastEdit = thread._edits[thread._edits.length - 1];
      // Should NOT contain [SILENT] or any final text — only status edits
      expect(lastEdit).not.toBe("[SILENT]");
      expect(thread._edits.every((e) => !e.includes("[SILENT]"))).toBe(true);
    });

    test("[SILENT] response still saves context", async () => {
      mockAgent.prompt = mock(() => {
        mockAgent._emit({ type: "agent_start" });
        const assistantMsg: AgentMessage = {
          role: "assistant",
          content: [{ type: "text", text: "[SILENT]" }],
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
        mockAgent.state.messages.push(assistantMsg);
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "periodic check", thread });
      await settle();

      // Context should still be saved even though response was silent
      const context = store.loadContext(THREAD_ID);
      expect(context.length).toBeGreaterThan(0);
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

  describe("descriptive error messages", () => {
    test("rate limit error → friendly message", async () => {
      mockAgent.prompt = mock(() => {
        throw new Error("429 too many requests");
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const allText = [...thread._posts, ...thread._edits];
      expect(allText.some((t) => t.includes("rate-limited"))).toBe(true);
    });

    test("overloaded error → friendly message", async () => {
      mockAgent.prompt = mock(() => {
        throw new Error("overloaded_error");
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const allText = [...thread._posts, ...thread._edits];
      expect(allText.some((t) => t.includes("overloaded"))).toBe(true);
    });

    test("timeout error → connection message", async () => {
      mockAgent.prompt = mock(() => {
        throw new Error("ETIMEDOUT");
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const allText = [...thread._posts, ...thread._edits];
      expect(allText.some((t) => t.includes("lost connection"))).toBe(true);
    });

    test("context overflow → thread too long message", async () => {
      mockAgent.prompt = mock(() => {
        throw new Error("prompt is too long: 200000 tokens > 128000 maximum");
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const allText = [...thread._posts, ...thread._edits];
      expect(allText.some((t) => t.includes("too long"))).toBe(true);
    });

    test("unknown error → includes raw message", async () => {
      mockAgent.prompt = mock(() => {
        throw new Error("something bizarre happened");
      });

      const actor = createActor();
      const thread = createMockThread();

      actor.receive({ type: "prompt", text: "hi", thread });
      await settle();

      const allText = [...thread._posts, ...thread._edits];
      expect(
        allText.some((t) => t.includes("something bizarre happened"))
      ).toBe(true);
      expect(allText.some((t) => t.includes("Something went wrong"))).toBe(
        true
      );
    });
  });

  describe("transport retry", () => {
    test("retries thread.post on RateLimitError then succeeds", async () => {
      let postCount = 0;
      const thread = createMockThread();
      const originalPost = thread.post;
      thread.post = mock(async (message: string) => {
        postCount++;
        if (postCount === 1) {
          throw new RateLimitError("rate limited", 10);
        }
        return (originalPost as (m: string) => Promise<SentMessage>)(message);
      }) as typeof thread.post;

      const actor = createActor();
      actor.receive({ type: "prompt", text: "hi", thread });
      await settle(200);

      // Should have retried and succeeded
      expect(postCount).toBeGreaterThan(1);
      expect(thread._posts.length).toBeGreaterThan(0);
    });

    test("retries sentMessage.edit on RateLimitError then succeeds", async () => {
      let editAttempt = 0;
      const thread = createMockThread();

      // Override to inject a failing edit on first attempt
      thread.post = mock(async (message: string) => {
        thread._posts.push(message);
        const makeMock = (t: string): SentMessage =>
          ({
            id: `msg-${Date.now()}`,
            text: t,
            edit: mock(async (newContent: string) => {
              editAttempt++;
              if (editAttempt === 1) {
                throw new RateLimitError("rate limited", 10);
              }
              thread._edits.push(newContent);
              return makeMock(newContent);
            }),
          }) as unknown as SentMessage;
        return makeMock(message);
      }) as typeof thread.post;

      const actor = createActor();
      actor.receive({ type: "prompt", text: "hi", thread });
      await settle(200);

      // edit was retried
      expect(editAttempt).toBeGreaterThan(1);
    });

    test("non-retryable errors propagate immediately", async () => {
      const thread = createMockThread();
      thread.post = mock(async () => {
        throw new Error("permission denied");
      }) as typeof thread.post;

      const actor = createActor();
      actor.receive({ type: "prompt", text: "hi", thread });
      await settle(100);

      // Should not have retried — post was called once per enqueue attempt
      // The error is caught by RunMessage.enqueue's catch, logged, and dropped
      // Actor continues to next prompt
      expect(mockAgent.prompt).toHaveBeenCalledTimes(1);
    });
  });
});

describe("describeError", () => {
  test("maps rate limit errors", () => {
    expect(describeError(new Error("429 too many requests"))).toContain(
      "rate-limited"
    );
  });

  test("maps overloaded errors", () => {
    expect(describeError(new Error("overloaded_error"))).toContain(
      "overloaded"
    );
  });

  test("maps timeout errors", () => {
    expect(describeError(new Error("request timed out"))).toContain(
      "lost connection"
    );
  });

  test("maps context overflow", () => {
    expect(
      describeError(new Error("prompt is too long: 200k tokens > 128k"))
    ).toContain("too long");
  });

  test("maps abort errors", () => {
    expect(describeError(new Error("Request was aborted"))).toContain(
      "interrupted"
    );
  });

  test("passes through unknown errors with raw message", () => {
    const result = describeError(new Error("weird stuff"));
    expect(result).toContain("Something went wrong");
    expect(result).toContain("weird stuff");
  });

  test("handles non-Error values", () => {
    expect(describeError("string error")).toContain("Something went wrong");
    expect(describeError(null)).toContain("Something went wrong");
  });
});

describe("isTransportRetryable", () => {
  test("RateLimitError is retryable", () => {
    expect(isTransportRetryable(new RateLimitError("limited"))).toBe(true);
  });

  test("network errors are retryable", () => {
    expect(isTransportRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(isTransportRetryable(new Error("ETIMEDOUT"))).toBe(true);
    expect(isTransportRetryable(new Error("network error"))).toBe(true);
  });

  test("5xx errors are retryable", () => {
    expect(isTransportRetryable(new Error("502 bad gateway"))).toBe(true);
    expect(isTransportRetryable(new Error("503 service unavailable"))).toBe(
      true
    );
  });

  test("non-retryable errors return false", () => {
    expect(isTransportRetryable(new Error("permission denied"))).toBe(false);
    expect(isTransportRetryable(new Error("not found"))).toBe(false);
    expect(isTransportRetryable("string")).toBe(false);
  });
});
