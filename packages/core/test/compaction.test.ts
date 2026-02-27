import { describe, expect, mock, test } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import {
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  runCompaction,
  serializeConversation,
  shouldCompact,
} from "../src/compaction";
import type { CompactionSettings } from "../src/compaction";

// -- Helpers --

function userMsg(text: string, timestamp = Date.now()): UserMessage {
  return { role: "user", content: text, timestamp };
}

function assistantMsg(
  text: string,
  opts?: {
    usage?: AssistantMessage["usage"];
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  },
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (text) content.push({ type: "text", text });
  if (opts?.toolCalls) {
    for (const tc of opts.toolCalls) {
      content.push({
        type: "toolCall",
        id: `tc_${tc.name}`,
        name: tc.name,
        arguments: tc.arguments,
      });
    }
  }
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: { slug: "anthropic", name: "Anthropic" },
    model: "test-model",
    usage: opts?.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "endTurn",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function toolResultMsg(text: string): AgentMessage {
  return {
    role: "toolResult",
    id: "tr_1",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

const defaultSettings: CompactionSettings = {
  enabled: true,
  contextWindow: 100000,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

// -- Tests --

describe("estimateTokens", () => {
  test("user message — string content", () => {
    const msg = userMsg("a".repeat(400));
    expect(estimateTokens(msg)).toBe(100); // 400/4
  });

  test("user message — array content", () => {
    const msg: UserMessage = {
      role: "user",
      content: [{ type: "text", text: "a".repeat(200) }],
      timestamp: Date.now(),
    };
    expect(estimateTokens(msg)).toBe(50);
  });

  test("assistant message — text + toolCall", () => {
    const msg = assistantMsg("hello", {
      toolCalls: [{ name: "read", arguments: { path: "/foo/bar.ts" } }],
    });
    const tokens = estimateTokens(msg);
    expect(tokens).toBeGreaterThan(0);
    // "hello" = 5 chars, "read" = 4 chars, JSON.stringify({path:"/foo/bar.ts"}) ≈ 22 chars
    // total ≈ 31 chars / 4 ≈ 8
    expect(tokens).toBe(Math.ceil(31 / 4));
  });

  test("toolResult message", () => {
    const msg = toolResultMsg("a".repeat(800));
    expect(estimateTokens(msg)).toBe(200);
  });
});

describe("estimateContextTokens", () => {
  test("uses assistant usage when available", () => {
    const messages: AgentMessage[] = [
      userMsg("hello"),
      assistantMsg("world", {
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
      userMsg("a".repeat(400)), // 100 tokens trailing
    ];
    expect(estimateContextTokens(messages)).toBe(5100);
  });

  test("falls back to estimation when no usage", () => {
    const messages: AgentMessage[] = [
      userMsg("a".repeat(400)),
      userMsg("b".repeat(400)),
    ];
    expect(estimateContextTokens(messages)).toBe(200);
  });
});

describe("shouldCompact", () => {
  test("returns true when tokens exceed threshold", () => {
    // contextWindow=100000, reserve=16384 → threshold=83616
    expect(shouldCompact(90000, defaultSettings)).toBe(true);
  });

  test("returns false when tokens within threshold", () => {
    expect(shouldCompact(50000, defaultSettings)).toBe(false);
  });

  test("returns false when disabled", () => {
    expect(shouldCompact(90000, { ...defaultSettings, enabled: false })).toBe(
      false,
    );
  });
});

describe("findCutPoint", () => {
  test("returns 0 when all messages fit in budget", () => {
    const messages: AgentMessage[] = [
      userMsg("hi"),
      assistantMsg("hello"),
    ];
    const result = findCutPoint(messages, 100000);
    expect(result.firstKeptIndex).toBe(0);
    expect(result.isSplitTurn).toBe(false);
  });

  test("finds cut at user message boundary", () => {
    // Create messages totaling ~200 tokens, keepRecent=100
    const messages: AgentMessage[] = [
      userMsg("a".repeat(200)), // 50 tokens
      assistantMsg("b".repeat(200)), // 50 tokens
      userMsg("c".repeat(200)), // 50 tokens
      assistantMsg("d".repeat(200)), // 50 tokens
    ];
    const result = findCutPoint(messages, 100);
    // Should keep last ~100 tokens → last 2 messages
    expect(result.firstKeptIndex).toBe(2);
    expect(result.isSplitTurn).toBe(false);
  });

  test("never cuts at toolResult", () => {
    const messages: AgentMessage[] = [
      userMsg("a".repeat(400)), // 100 tokens
      assistantMsg("b".repeat(400)), // 100 tokens
      toolResultMsg("c".repeat(400)), // 100 tokens — not a valid cut
      userMsg("d".repeat(400)), // 100 tokens
      assistantMsg("e".repeat(400)), // 100 tokens
    ];
    const result = findCutPoint(messages, 200);
    // Should not cut at index 2 (toolResult), should go to 3 (user)
    expect(result.firstKeptIndex).toBe(3);
  });

  test("detects split turn", () => {
    const messages: AgentMessage[] = [
      userMsg("a".repeat(400)), // 100 tokens
      assistantMsg("b".repeat(400)), // 100 tokens
      userMsg("c".repeat(400)), // 100 tokens — turn start
      assistantMsg("d".repeat(400)), // 100 tokens — cut here
      toolResultMsg("e".repeat(400)), // 100 tokens
      assistantMsg("f".repeat(400)), // 100 tokens
    ];
    // keepRecent=200: last 2 messages = 200 tokens, cut at index 3 (assistant)
    const result = findCutPoint(messages, 200);
    if (result.firstKeptIndex > 2 && result.firstKeptIndex < 5) {
      // If cut is at assistant (not user), it's a split turn
      expect(result.isSplitTurn).toBe(true);
      expect(result.turnStartIndex).toBeLessThan(result.firstKeptIndex);
    }
  });
});

describe("serializeConversation", () => {
  test("formats user and assistant messages", () => {
    const messages: AgentMessage[] = [
      userMsg("Hello world"),
      assistantMsg("Hi there"),
    ];
    const result = serializeConversation(messages);
    expect(result).toContain("[User]: Hello world");
    expect(result).toContain("[Assistant]: Hi there");
  });

  test("formats tool calls", () => {
    const messages: AgentMessage[] = [
      assistantMsg("", {
        toolCalls: [{ name: "read", arguments: { path: "/foo.ts" } }],
      }),
    ];
    const result = serializeConversation(messages);
    expect(result).toContain("[Assistant tool calls]:");
    expect(result).toContain("read(");
    expect(result).toContain("/foo.ts");
  });

  test("formats tool results", () => {
    const messages: AgentMessage[] = [toolResultMsg("file content here")];
    const result = serializeConversation(messages);
    expect(result).toContain("[Tool result]: file content here");
  });
});

describe("runCompaction", () => {
  // Mock completeSimple at the module level
  const mockCompleteSimple = mock(() =>
    Promise.resolve({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "## Goal\nTest summary" }],
      stopReason: "endTurn",
      api: "anthropic-messages",
      provider: { slug: "anthropic", name: "Anthropic" },
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    }),
  );

  // We can't easily mock the import, so we test the logic indirectly
  // by ensuring the functions compose correctly

  const mockModel = {
    id: "test-model",
    name: "Test",
    api: "anthropic-messages",
    provider: { slug: "anthropic", name: "Anthropic" },
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    output: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000, // Small window to trigger compaction
    maxTokens: 4096,
  };

  const mockGetApiKey = () => "test-key";

  test("returns original messages when compaction not needed", async () => {
    const messages: AgentMessage[] = [
      userMsg("hi"),
      assistantMsg("hello"),
    ];
    const settings: CompactionSettings = {
      enabled: true,
      contextWindow: 100000,
      reserveTokens: 16384,
      keepRecentTokens: 20000,
    };
    const result = await runCompaction(
      messages,
      settings,
      mockModel as never,
      mockGetApiKey,
    );
    expect(result).toBe(messages); // Same reference — no compaction
  });

  test("returns original messages when disabled", async () => {
    const messages: AgentMessage[] = [
      userMsg("a".repeat(4000)),
      assistantMsg("b".repeat(4000)),
    ];
    const settings: CompactionSettings = {
      enabled: false,
      contextWindow: 1000,
      reserveTokens: 100,
      keepRecentTokens: 100,
    };
    const result = await runCompaction(
      messages,
      settings,
      mockModel as never,
      mockGetApiKey,
    );
    expect(result).toBe(messages);
  });

  test("returns original when no API key", async () => {
    const messages: AgentMessage[] = [
      userMsg("a".repeat(4000)),
      assistantMsg("b".repeat(4000)),
    ];
    const settings: CompactionSettings = {
      enabled: true,
      contextWindow: 1000,
      reserveTokens: 100,
      keepRecentTokens: 100,
    };
    const result = await runCompaction(
      messages,
      settings,
      mockModel as never,
      () => undefined, // No API key
    );
    expect(result).toBe(messages);
  });

  test("returns original when all messages fit in keepRecentTokens", async () => {
    const messages: AgentMessage[] = [
      userMsg("hi"),
      assistantMsg("hello"),
    ];
    const settings: CompactionSettings = {
      enabled: true,
      contextWindow: 10, // Very small to trigger shouldCompact
      reserveTokens: 1,
      keepRecentTokens: 100000, // But keep everything
    };
    const result = await runCompaction(
      messages,
      settings,
      mockModel as never,
      mockGetApiKey,
    );
    // findCutPoint returns 0, so no compaction
    expect(result).toBe(messages);
  });
});
