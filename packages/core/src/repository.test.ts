import { expect } from "bun:test";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Effect, Layer } from "effect";
import { makeDbLayer } from "./db.ts";
import { ThreadStore } from "./repository.ts";
import { it } from "./test.ts";
import { TransportId, ThreadId } from "./schema.ts";

const CLI = TransportId.make("cli");
const WEB = TransportId.make("web");
const tid = ThreadId.make;

/** Shorthand for creating a user AgentMessage in tests. */
const userMsg = (text: string): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

/** Shorthand for creating an assistant AgentMessage in tests. */
const assistantMsg = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "mock",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: Date.now(),
} as AgentMessage);

const TestLayer = Layer.provideMerge(ThreadStore.layer, makeDbLayer(":memory:"));

it.layer(TestLayer)("repository", (it) => {
  // -- threads ----------------------------------------------------------------

  it.effect("getOrCreateThread creates a new thread", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("default"));

      expect(thread.transport).toBe(CLI);
      expect(thread.threadId).toBe(tid("default"));
      expect(thread.status).toBe("idle");
      expect(thread.leafId).toBeNull();
    }),
  );

  it.effect("getOrCreateThread returns existing thread", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const a = yield* repo.getOrCreateThread(CLI, tid("chan-1"));
      const b = yield* repo.getOrCreateThread(CLI, tid("chan-1"));
      expect(a.threadId).toBe(b.threadId);
    }),
  );

  it.effect("getThread returns null for missing id", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const result = yield* repo.getThread(tid("nonexistent"));
      expect(result).toBeNull();
    }),
  );

  it.effect("listThreads filters by transport", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      yield* repo.getOrCreateThread(CLI, tid("a"));
      yield* repo.getOrCreateThread(WEB, tid("b"));
      yield* repo.getOrCreateThread(CLI, tid("c"));

      const cliThreads = yield* repo.listThreads(CLI);
      expect(cliThreads.length).toBe(2);
      expect(cliThreads.every((t) => t.transport === CLI)).toBe(true);

      const all = yield* repo.listThreads();
      expect(all.length).toBe(3);
    }),
  );

  // -- messages ---------------------------------------------------------------

  it.effect("insertMessage stores message and updates leaf", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("msg-test"));
      const content = userMsg("hello");
      const msg = yield* repo.insertMessage(thread.threadId, null, content);

      expect(msg.threadId).toBe(thread.threadId);
      expect(msg.parentId).toBeNull();
      expect(msg.content.role).toBe("user");
      expect(msg.content).toMatchObject({ role: "user", content: [{ type: "text", text: "hello" }] });

      const updated = yield* repo.getThread(thread.threadId);
      expect(updated!.leafId).toBe(msg.id);
    }),
  );

  it.effect("countMessages returns correct count", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("count-test"));

      expect(yield* repo.countMessages(thread.threadId)).toBe(0);

      const m1 = yield* repo.insertMessage(thread.threadId, null, userMsg("one"));
      yield* repo.insertMessage(thread.threadId, m1.id, assistantMsg("two"));

      expect(yield* repo.countMessages(thread.threadId)).toBe(2);
    }),
  );

  // -- context ----------------------------------------------------------------

  it.effect("getContext walks parent chain oldest-first", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("ctx-test"));

      const m1 = yield* repo.insertMessage(thread.threadId, null, userMsg("first"));
      const m2 = yield* repo.insertMessage(thread.threadId, m1.id, assistantMsg("second"));
      const m3 = yield* repo.insertMessage(thread.threadId, m2.id, userMsg("third"));

      const ctx = yield* repo.getContext(thread.threadId);
      expect(ctx.length).toBe(3);
      expect(ctx[0]!.id).toBe(m1.id);
      expect(ctx[2]!.id).toBe(m3.id);
      expect(ctx[0]!.content).toMatchObject({ role: "user" });
      expect(ctx[1]!.content).toMatchObject({ role: "assistant" });
      expect(ctx[2]!.content).toMatchObject({ role: "user" });
    }),
  );

  it.effect("getContext returns empty for thread with no messages", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("empty-ctx"));
      const ctx = yield* repo.getContext(thread.threadId);
      expect(ctx).toEqual([]);
    }),
  );

  it.effect("getContext follows branch after re-parenting leaf", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("branch-test"));

      // Build a linear chain: m1 → m2 → m3
      const m1 = yield* repo.insertMessage(thread.threadId, null, userMsg("root"));
      const m2 = yield* repo.insertMessage(thread.threadId, m1.id, assistantMsg("reply-a"));
      yield* repo.insertMessage(thread.threadId, m2.id, userMsg("follow-up-a"));

      // Branch from m1: m1 → m4 → m5 (new branch)
      const m4 = yield* repo.insertMessage(thread.threadId, m1.id, assistantMsg("reply-b"));
      const m5 = yield* repo.insertMessage(thread.threadId, m4.id, userMsg("follow-up-b"));

      // Leaf is now m5, so context should follow the branch
      const ctx = yield* repo.getContext(thread.threadId);
      expect(ctx.length).toBe(3);
      expect(ctx[0]!.id).toBe(m1.id);
      expect(ctx[2]!.id).toBe(m5.id);
    }),
  );

  it.effect("getContext handles deep branch correctly", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("deep-branch"));

      // Build: root → a1 → a2 → a3
      const root = yield* repo.insertMessage(thread.threadId, null, userMsg("root"));
      const a1 = yield* repo.insertMessage(thread.threadId, root.id, assistantMsg("a1"));
      const a2 = yield* repo.insertMessage(thread.threadId, a1.id, userMsg("a2"));
      yield* repo.insertMessage(thread.threadId, a2.id, assistantMsg("a3"));

      // Branch from a1: root → a1 → b1 → b2
      const b1 = yield* repo.insertMessage(thread.threadId, a1.id, userMsg("b1"));
      const b2 = yield* repo.insertMessage(thread.threadId, b1.id, assistantMsg("b2"));

      // Branch from root: root → c1
      yield* repo.insertMessage(thread.threadId, root.id, assistantMsg("c1"));

      // Leaf is c1, context should be root → c1
      const ctx = yield* repo.getContext(thread.threadId);
      expect(ctx.length).toBe(2);

      // Now extend the b-branch: leaf moves to b3
      yield* repo.insertMessage(thread.threadId, b2.id, userMsg("b3"));
      const ctx2 = yield* repo.getContext(thread.threadId);
      expect(ctx2.length).toBe(5);
    }),
  );

  it.effect("countMessages counts all messages across branches", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread(CLI, tid("count-branch"));

      const m1 = yield* repo.insertMessage(thread.threadId, null, userMsg("root"));
      yield* repo.insertMessage(thread.threadId, m1.id, assistantMsg("branch-a"));
      yield* repo.insertMessage(thread.threadId, m1.id, assistantMsg("branch-b"));

      // All 3 messages exist regardless of which branch is active
      expect(yield* repo.countMessages(thread.threadId)).toBe(3);
    }),
  );
});
