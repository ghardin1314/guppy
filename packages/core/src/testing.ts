/**
 * Shared test doubles and helpers for @guppy/core tests.
 *
 * Re-exports the Effect-aware test runner from ./test.ts and provides:
 *  - EchoAgentFactoryLive — deterministic echo agent (no LLM calls)
 *  - TestTransport helpers — in-memory transport recording events
 *  - testConfig — default AgentThreadConfig for tests
 *  - collectUntilEnd — drain events until agent_end
 *  - withThread — spawn a scoped thread for a test body
 */

import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { Chunk, Effect, Exit, Layer, Scope, Stream } from "effect";
import {
  AgentError,
  AgentFactory,
  type AgentHandle,
  type CreateAgentConfig,
} from "./agent.ts";
import {
  spawn,
  type AgentThreadConfig,
  type AgentThreadHandle,
} from "./agent-thread.ts";
import { ThreadStore } from "./repository.ts";
import { TransportService, type Transport } from "./transport.ts";
import { TransportRegistry } from "./transport-registry.ts";
import { TransportId, ThreadId } from "./schema.ts";

export { it } from "./test.ts";

// -- Echo agent factory -------------------------------------------------------

export const EchoAgentFactoryLive = Layer.succeed(AgentFactory, {
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

// -- Instrumented agent factory -----------------------------------------------

export interface InstrumentedAgentState {
  readonly createConfigs: CreateAgentConfig[];
  readonly steerCalls: AgentMessage[];
  readonly followUpCalls: AgentMessage[];
  continueCalls: number;
  abortCalls: number;
}

/**
 * Agent factory that records all calls for test assertions.
 * Supports configurable prompt delay for testing streaming-related paths.
 */
export function makeInstrumentedAgentFactory(opts?: {
  promptDelayMs?: number;
}): {
  state: InstrumentedAgentState;
  layer: Layer.Layer<AgentFactory>;
} {
  const delayMs = opts?.promptDelayMs ?? 0;
  const state: InstrumentedAgentState = {
    createConfigs: [],
    steerCalls: [],
    followUpCalls: [],
    continueCalls: 0,
    abortCalls: 0,
  };

  const layer = Layer.succeed(AgentFactory, {
    create: (config) =>
      Effect.sync(() => {
        state.createConfigs.push(config);
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
              }, delayMs);
            }),
          steer: (msg) => {
            state.steerCalls.push(msg);
            msgs.push(msg);
          },
          followUp: (msg) => {
            state.followUpCalls.push(msg);
            msgs.push(msg);
          },
          continue: () => {
            state.continueCalls++;
            return Effect.void;
          },
          abort: () => {
            state.abortCalls++;
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

  return { state, layer };
}

// -- Test transport -----------------------------------------------------------

export interface TestTransportState {
  readonly contextCalls: ThreadId[];
  readonly delivered: Array<{ threadId: ThreadId; event: AgentEvent }>;
  contextValue: string;
}

export function makeTestTransport(contextValue = ""): {
  state: TestTransportState;
  transport: Transport;
  layer: Layer.Layer<TransportService>;
} {
  const state: TestTransportState = {
    contextCalls: [],
    delivered: [],
    contextValue,
  };

  const transport: Transport = {
    getContext: (threadId) =>
      Effect.sync(() => {
        state.contextCalls.push(threadId);
        return state.contextValue;
      }),
    deliver: (threadId, event) =>
      Effect.sync(() => {
        state.delivered.push({ threadId, event });
      }),
  };

  const layer = Layer.succeed(TransportService, transport);

  return { state, transport, layer };
}

export function makeRegisteredTestTransport(
  name: TransportId,
  contextValue = "",
): {
  state: TestTransportState;
  layer: Layer.Layer<never, never, TransportRegistry>;
} {
  const { state, transport } = makeTestTransport(contextValue);

  const layer = Layer.effectDiscard(
    Effect.gen(function* () {
      const registry = yield* TransportRegistry;
      yield* registry.register(name, transport);
    }),
  );

  return { state, layer };
}

// -- Default test config ------------------------------------------------------

export const testConfig: AgentThreadConfig = {
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  systemPrompt: "You are a test agent.",
};

// -- Helpers ------------------------------------------------------------------

/** Collect events from a thread handle until agent_end. */
export function collectUntilEnd(
  handle: AgentThreadHandle,
): Effect.Effect<AgentEvent[]> {
  return handle.events.pipe(
    Stream.takeUntil((e) => e.type === "agent_end"),
    Stream.runCollect,
    Effect.map((chunk) => [...chunk]),
  );
}

/**
 * Spawn a scoped thread for a test body.
 * Creates a thread via ThreadStore, spawns it, runs fn, then closes scope.
 */
export const withThread = (
  threadId: string,
  fn: (
    handle: AgentThreadHandle,
    threadId: ThreadId,
  ) => Effect.Effect<void, unknown, ThreadStore | AgentFactory>,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const tid = ThreadId.make(threadId);
    yield* store.getOrCreateThread(TransportId.make("test"), tid);

    const scope = yield* Scope.make();
    const handle = yield* spawn(testConfig, tid).pipe(
      Effect.provideService(Scope.Scope, scope),
    );

    yield* fn(handle, tid);

    yield* Scope.close(scope, Exit.succeed(void 0));
  });
