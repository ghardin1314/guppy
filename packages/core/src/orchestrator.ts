/**
 * Orchestrator: manages agent thread lifecycle.
 *
 * - Resolves transport + channel → thread (via ThreadStore)
 * - Spawns agent threads with their transport provided via TransportMap
 * - Routes inbound messages to the correct thread
 *
 * Transports call orchestrator.getOrCreateThread + orchestrator.send
 * for inbound messages. The orchestrator spawns threads lazily and
 * provides the correct TransportService via TransportMap.get(name).
 */

import type { SqlError } from "@effect/sql";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  Context,
  Effect,
  ExecutionStrategy,
  HashMap,
  Layer,
  Ref,
  Scope,
  Stream,
} from "effect";
import {
  spawn,
  type AgentThreadConfig,
  type AgentThreadHandle,
} from "./agent-thread.ts";
import { AgentError, AgentFactory } from "./agent.ts";
import { ThreadStore } from "./repository.ts";
import { ThreadMessage } from "./thread-message.ts";
import { TransportMap } from "./transport-map.ts";
import { TransportNotFoundError } from "./transport-registry.ts";

// -- Service interface --------------------------------------------------------

export interface OrchestratorService {
  /** Resolve a transport + channel to a thread id, creating if needed. */
  readonly getOrCreateThread: (
    transport: string,
    channelId: string,
  ) => Effect.Effect<string, SqlError.SqlError>;

  /** Send a message to a thread. Spawns the thread if not already running. */
  readonly send: (
    threadId: string,
    transportName: string,
    msg: ThreadMessage,
    config: AgentThreadConfig,
  ) => Effect.Effect<
    void,
    SqlError.SqlError | AgentError | TransportNotFoundError
  >;

  /** Get a running thread's event stream, if it exists. */
  readonly events: (
    threadId: string,
  ) => Effect.Effect<Stream.Stream<AgentEvent> | null>;
}

// -- Tag ----------------------------------------------------------------------

export class Orchestrator extends Context.Tag("@guppy/core/Orchestrator")<
  Orchestrator,
  OrchestratorService
>() {}

// -- Live implementation ------------------------------------------------------

export const OrchestratorLive = Layer.scoped(
  Orchestrator,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const transportMap = yield* TransportMap;
    const scope = yield* Effect.scope;
    const spawnCtx = yield* Effect.context<AgentFactory | ThreadStore>();

    const threads = yield* Ref.make(HashMap.empty<string, AgentThreadHandle>());

    const getOrSpawn = (
      threadId: string,
      transportName: string,
      config: AgentThreadConfig,
    ): Effect.Effect<
      AgentThreadHandle,
      SqlError.SqlError | AgentError | TransportNotFoundError
    > =>
      Effect.gen(function* () {
        const map = yield* Ref.get(threads);
        const existing = HashMap.get(map, threadId);
        if (existing._tag === "Some") return existing.value;

        const threadScope = yield* Scope.fork(
          scope,
          ExecutionStrategy.sequential,
        );

        const handle = yield* spawn(threadId, config).pipe(
          Effect.provide(transportMap.get(transportName)),
          Effect.provide(spawnCtx),
          Effect.provideService(Scope.Scope, threadScope),
        );

        yield* Ref.update(threads, HashMap.set(threadId, handle));
        return handle;
      });

    return Orchestrator.of({
      getOrCreateThread: (transport, channelId) =>
        Effect.gen(function* () {
          const thread = yield* store.getOrCreateThread(transport, channelId);
          return thread.id;
        }),

      send: (threadId, transportName, msg, config) =>
        Effect.gen(function* () {
          const handle = yield* getOrSpawn(threadId, transportName, config);
          yield* handle.send(msg);
        }),

      events: (threadId) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(threads);
          const entry = HashMap.get(map, threadId);
          if (entry._tag === "None") return null;
          return entry.value.events;
        }),
    });
  }),
);
