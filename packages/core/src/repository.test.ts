import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { makeDbLayer } from "./db.ts";
import { ThreadStore, ThreadStoreLive } from "./repository.ts";
import { it } from "./test.ts";

const TestLayer = Layer.provideMerge(ThreadStoreLive, makeDbLayer(":memory:"));

it.layer(TestLayer)("repository", (it) => {
  // -- threads ----------------------------------------------------------------

  it.effect("getOrCreateThread creates a new thread", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "default");

      expect(thread.transport).toBe("cli");
      expect(thread.channelId).toBe("default");
      expect(thread.status).toBe("idle");
      expect(thread.leafId).toBeNull();
    }),
  );

  it.effect("getOrCreateThread returns existing thread", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const a = yield* repo.getOrCreateThread("cli", "chan-1");
      const b = yield* repo.getOrCreateThread("cli", "chan-1");
      expect(a.id).toBe(b.id);
    }),
  );

  it.effect("getThread returns null for missing id", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const result = yield* repo.getThread("nonexistent");
      expect(result).toBeNull();
    }),
  );

  it.effect("listThreads filters by transport", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      yield* repo.getOrCreateThread("cli", "a");
      yield* repo.getOrCreateThread("web", "b");
      yield* repo.getOrCreateThread("cli", "c");

      const cliThreads = yield* repo.listThreads("cli");
      expect(cliThreads.length).toBe(2);
      expect(cliThreads.every((t) => t.transport === "cli")).toBe(true);

      const all = yield* repo.listThreads();
      expect(all.length).toBe(3);
    }),
  );

  // -- messages ---------------------------------------------------------------

  it.effect("insertMessage stores message and updates leaf", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "msg-test");
      const msg = yield* repo.insertMessage(thread.id, null, "user", "hello");

      expect(msg.threadId).toBe(thread.id);
      expect(msg.parentId).toBeNull();
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("hello");

      const updated = yield* repo.getThread(thread.id);
      expect(updated!.leafId).toBe(msg.id);
    }),
  );

  it.effect("countMessages returns correct count", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "count-test");

      expect(yield* repo.countMessages(thread.id)).toBe(0);

      const m1 = yield* repo.insertMessage(thread.id, null, "user", "one");
      yield* repo.insertMessage(thread.id, m1.id, "assistant", "two");

      expect(yield* repo.countMessages(thread.id)).toBe(2);
    }),
  );

  // -- context ----------------------------------------------------------------

  it.effect("getContext walks parent chain oldest-first", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "ctx-test");

      const m1 = yield* repo.insertMessage(thread.id, null, "user", "first");
      const m2 = yield* repo.insertMessage(
        thread.id,
        m1.id,
        "assistant",
        "second",
      );
      const m3 = yield* repo.insertMessage(thread.id, m2.id, "user", "third");

      const ctx = yield* repo.getContext(thread.id);
      expect(ctx.map((m) => m.content)).toEqual(["first", "second", "third"]);
      expect(ctx[0]!.id).toBe(m1.id);
      expect(ctx[2]!.id).toBe(m3.id);
    }),
  );

  it.effect("getContext returns empty for thread with no messages", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "empty-ctx");
      const ctx = yield* repo.getContext(thread.id);
      expect(ctx).toEqual([]);
    }),
  );

  it.effect("getContext follows branch after re-parenting leaf", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "branch-test");

      // Build a linear chain: m1 → m2 → m3
      const m1 = yield* repo.insertMessage(thread.id, null, "user", "root");
      const m2 = yield* repo.insertMessage(thread.id, m1.id, "assistant", "reply-a");
      yield* repo.insertMessage(thread.id, m2.id, "user", "follow-up-a");

      // Branch from m1: m1 → m4 → m5 (new branch)
      const m4 = yield* repo.insertMessage(thread.id, m1.id, "assistant", "reply-b");
      const m5 = yield* repo.insertMessage(thread.id, m4.id, "user", "follow-up-b");

      // Leaf is now m5, so context should follow the branch
      const ctx = yield* repo.getContext(thread.id);
      expect(ctx.map((m) => m.content)).toEqual(["root", "reply-b", "follow-up-b"]);
      expect(ctx[0]!.id).toBe(m1.id);
      expect(ctx[2]!.id).toBe(m5.id);
    }),
  );

  it.effect("getContext handles deep branch correctly", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "deep-branch");

      // Build: root → a1 → a2 → a3
      const root = yield* repo.insertMessage(thread.id, null, "user", "root");
      const a1 = yield* repo.insertMessage(thread.id, root.id, "assistant", "a1");
      const a2 = yield* repo.insertMessage(thread.id, a1.id, "user", "a2");
      yield* repo.insertMessage(thread.id, a2.id, "assistant", "a3");

      // Branch from a1: root → a1 → b1 → b2
      const b1 = yield* repo.insertMessage(thread.id, a1.id, "user", "b1");
      const b2 = yield* repo.insertMessage(thread.id, b1.id, "assistant", "b2");

      // Branch from root: root → c1
      yield* repo.insertMessage(thread.id, root.id, "assistant", "c1");

      // Leaf is c1, context should be root → c1
      const ctx = yield* repo.getContext(thread.id);
      expect(ctx.map((m) => m.content)).toEqual(["root", "c1"]);

      // Now extend the b-branch: leaf moves to b3
      yield* repo.insertMessage(thread.id, b2.id, "user", "b3");
      const ctx2 = yield* repo.getContext(thread.id);
      expect(ctx2.map((m) => m.content)).toEqual(["root", "a1", "b1", "b2", "b3"]);
    }),
  );

  it.effect("countMessages counts all messages across branches", () =>
    Effect.gen(function* () {
      const repo = yield* ThreadStore;
      const thread = yield* repo.getOrCreateThread("cli", "count-branch");

      const m1 = yield* repo.insertMessage(thread.id, null, "user", "root");
      yield* repo.insertMessage(thread.id, m1.id, "assistant", "branch-a");
      yield* repo.insertMessage(thread.id, m1.id, "assistant", "branch-b");

      // All 3 messages exist regardless of which branch is active
      expect(yield* repo.countMessages(thread.id)).toBe(3);
    }),
  );
});
