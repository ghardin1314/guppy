/**
 * Orchestrator: virtual actor manager for agent threads.
 *
 * Callers address threads by (transport, channelId). The orchestrator
 * resolves this to a thread, spawns it if needed, and routes messages.
 * No lifecycle management leaks to callers.
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
  /** Send to a virtual agent thread addressed by (transport, channelId).
   *  Creates thread if needed, spawns if not running. */
  readonly send: (
    transport: string,
    channelId: string,
    msg: ThreadMessage,
  ) => Effect.Effect<
    void,
    SqlError.SqlError | AgentError | TransportNotFoundError
  >;

  /** Get event stream for a thread. Returns null if not currently spawned. */
  readonly events: (
    transport: string,
    channelId: string,
  ) => Effect.Effect<Stream.Stream<AgentEvent> | null, SqlError.SqlError>;
}

// -- Tag ----------------------------------------------------------------------

export class Orchestrator extends Context.Tag("@guppy/core/Orchestrator")<
  Orchestrator,
  OrchestratorService
>() {}

// -- Live implementation ------------------------------------------------------

export const OrchestratorLive = (
  config: AgentThreadConfig,
): Layer.Layer<
  Orchestrator,
  never,
  AgentFactory | ThreadStore | TransportMap
> =>
  Layer.scoped(
    Orchestrator,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const transportMap = yield* TransportMap;
      const scope = yield* Effect.scope;
      const spawnCtx = yield* Effect.context<AgentFactory | ThreadStore>();

      const threads = yield* Ref.make(
        HashMap.empty<string, AgentThreadHandle>(),
      );

      const getOrSpawn = (
        threadId: string,
        transportName: string,
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
        send: (transport, channelId, msg) =>
          Effect.gen(function* () {
            const thread = yield* store.getOrCreateThread(transport, channelId);
            const handle = yield* getOrSpawn(thread.id, thread.transport);
            yield* handle.send(msg);
          }),

        events: (transport, channelId) =>
          Effect.gen(function* () {
            const thread = yield* store.getOrCreateThread(transport, channelId);
            const map = yield* Ref.get(threads);
            const entry = HashMap.get(map, thread.id);
            if (entry._tag === "None") return null;
            return entry.value.events;
          }),
      });
    }),
  );
