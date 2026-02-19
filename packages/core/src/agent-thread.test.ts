import { expect } from "bun:test";
import { Chunk, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { getModel } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { makeDbLayer } from "./db.ts";
import { ThreadStore, ThreadStoreLive } from "./repository.ts";
import { AgentFactory, AgentError, type AgentHandle } from "./agent.ts";
import {
  spawn,
  type AgentThreadHandle,
  type AgentThreadConfig,
} from "./agent-thread.ts";
import { ThreadMessage } from "./thread-message.ts";
import { it } from "./test.ts";

// -- Echo agent factory (test double) -----------------------------------------

const EchoAgentFactoryLive = Layer.succeed(AgentFactory, {
  create: (config) =>
    Effect.sync(() => {
      const msgs: AgentMessage[] = [...(config.messages ?? [])];
      const listeners = new Set<(event: AgentEvent) => void>();
      let streaming = false;

      const emit = (type: string) => {
        const event = { type } as AgentEvent;
        for (const fn of listeners) fn(event);
      };

      return {
        prompt: (content) =>
          Effect.async<void, AgentError>((resume) => {
            streaming = true;
            const text =
              typeof content === "string"
                ? content
                : JSON.stringify(content);

            msgs.push({
              role: "user",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            } as AgentMessage);

            msgs.push({
              role: "assistant",
              content: [{ type: "text", text: `echo: ${text}` }],
              api: "anthropic-messages",
              provider: "anthropic",
              model: "mock",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
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
            } as AgentMessage);

            setTimeout(() => {
              emit("turn_end");
              streaming = false;
              emit("agent_end");
              resume(Effect.void);
            }, 0);
          }),
        steer: (msg) => {
          msgs.push(msg);
        },
        followUp: (msg) => {
          msgs.push(msg);
        },
        continue: () => Effect.void,
        abort: () => {
          streaming = false;
        },
        isStreaming: () => streaming,
        messages: () => msgs,
        events: Stream.async<AgentEvent>((emit) => {
          const fn = (event: AgentEvent) => {
            emit(Effect.succeed(Chunk.of(event)));
          };
          listeners.add(fn);
          return Effect.sync(() => {
            listeners.delete(fn);
          });
        }),
      } satisfies AgentHandle;
    }),
});

// -- Layers -------------------------------------------------------------------

const DbLayer = makeDbLayer(":memory:");
const StoreLayer = Layer.provideMerge(ThreadStoreLive, DbLayer);
const TestLayer = Layer.merge(StoreLayer, EchoAgentFactoryLive);

// -- Test config --------------------------------------------------------------

const testConfig: AgentThreadConfig = {
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  systemPrompt: "You are a test agent.",
};

// -- Helpers ------------------------------------------------------------------

function collectUntilEnd(
  handle: AgentThreadHandle,
): Effect.Effect<AgentEvent[]> {
  return handle.events.pipe(
    Stream.takeUntil((e) => e.type === "agent_end"),
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  );
}

const withThread = (
  channelId: string,
  fn: (
    handle: AgentThreadHandle,
    threadId: string,
  ) => Effect.Effect<void, unknown, ThreadStore | AgentFactory>,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const thread = yield* store.getOrCreateThread("test", channelId);

    const scope = yield* Scope.make();
    const handle = yield* spawn(thread.id, testConfig).pipe(
      Effect.provideService(Scope.Scope, scope),
    );

    yield* fn(handle, thread.id);

    yield* Scope.close(scope, Exit.succeed(void 0));
  });

// -- Tests --------------------------------------------------------------------

it.layer(TestLayer)("agent-thread", (it) => {
  it.live("processes a prompt and emits agent_end", () =>
    withThread("t1", (handle) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "hello" }));
        const events = yield* Fiber.join(fiber);

        const types = events.map((e) => e.type);
        expect(types).toContain("turn_end");
        expect(types).toContain("agent_end");
      }),
    ),
  );

  it.live("persists user and assistant messages", () =>
    withThread("t2", (handle, threadId) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const fiber = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "persist me" }));
        yield* Fiber.join(fiber);

        // Let persist fiber process the turn_end event
        yield* Effect.yieldNow();

        const ctx = yield* store.getContext(threadId);
        expect(ctx.length).toBeGreaterThanOrEqual(2);
        expect(ctx[0]!.role).toBe("user");
        expect(JSON.parse(ctx[0]!.content)).toEqual([
          { type: "text", text: "persist me" },
        ]);
        expect(ctx[1]!.role).toBe("assistant");
      }),
    ),
  );

  it.live("processes messages sequentially", () =>
    withThread("t3", (handle, threadId) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;

        const f1 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "first" }));
        yield* Fiber.join(f1);
        yield* Effect.yieldNow();

        const f2 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "second" }));
        yield* Fiber.join(f2);
        yield* Effect.yieldNow();

        const ctx = yield* store.getContext(threadId);
        expect(ctx.length).toBeGreaterThanOrEqual(4);
        expect(ctx[0]!.role).toBe("user");
        expect(ctx[1]!.role).toBe("assistant");
        expect(ctx[2]!.role).toBe("user");
        expect(ctx[3]!.role).toBe("assistant");
      }),
    ),
  );

  it.live("stop with no active run returns false", () =>
    withThread("t4", (handle) =>
      Effect.gen(function* () {
        const result = yield* handle.send(ThreadMessage.Stop());
        expect(result).toBe(false);
      }),
    ),
  );

  it.live("context builds across multiple prompts", () =>
    withThread("t5", (handle, threadId) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;

        const f1 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "msg1" }));
        yield* Fiber.join(f1);
        yield* Effect.yieldNow();

        const f2 = yield* Effect.fork(collectUntilEnd(handle));
        yield* handle.send(ThreadMessage.Prompt({ content: "msg2" }));
        yield* Fiber.join(f2);
        yield* Effect.yieldNow();

        const ctx = yield* store.getContext(threadId);
        expect(ctx.length).toBeGreaterThanOrEqual(4);
        expect(JSON.parse(ctx[0]!.content)).toEqual([
          { type: "text", text: "msg1" },
        ]);
        expect(JSON.parse(ctx[2]!.content)).toEqual([
          { type: "text", text: "msg2" },
        ]);
      }),
    ),
  );
});
