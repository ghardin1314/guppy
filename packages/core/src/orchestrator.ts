/**
 * Orchestrator: virtual actor manager for agent threads.
 *
 * Callers address threads by (transport, threadId). The orchestrator
 * resolves this to a thread row, spawns if needed, and routes messages.
 * No lifecycle management leaks to callers.
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  Context,
  Effect,
  ExecutionStrategy,
  HashMap,
  Layer,
  Ref,
  Schema,
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
import type { TransportId, ThreadId } from "./schema.ts";

// -- Errors -------------------------------------------------------------------
const OrchestratorErrorReason = Schema.Literal("STORAGE_ERROR");

export class OrchestratorError extends Schema.TaggedError<OrchestratorError>()(
  "OrchestratorError",
  {
    message: Schema.String,
    reason: OrchestratorErrorReason,
    cause: Schema.Unknown.pipe(Schema.optional),
  },
) {}

// -- Service interface --------------------------------------------------------

export type OrchestratorSendError =
  | OrchestratorError
  | AgentError
  | TransportNotFoundError;

export interface OrchestratorService {
  /** Send to a virtual agent thread. Creates thread if needed, spawns if not running. */
  readonly send: (
    transport: TransportId,
    threadId: ThreadId,
    msg: ThreadMessage,
  ) => Effect.Effect<void, OrchestratorSendError>;

  /** Get event stream for a thread. Returns null if not currently spawned. */
  readonly events: (
    transport: TransportId,
    threadId: ThreadId,
  ) => Effect.Effect<Stream.Stream<AgentEvent> | null, OrchestratorError>;
}

// -- Tag ----------------------------------------------------------------------

export class Orchestrator extends Context.Tag("@guppy/core/Orchestrator")<
  Orchestrator,
  OrchestratorService
>() {
  static layer = (
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
          HashMap.empty<ThreadId, AgentThreadHandle>(),
        );

        const getOrSpawn = (
          threadId: ThreadId,
          transport: TransportId,
        ): Effect.Effect<
          AgentThreadHandle,
          OrchestratorError | AgentError | TransportNotFoundError
        > =>
          Effect.gen(function* () {
            const map = yield* Ref.get(threads);
            const existing = HashMap.get(map, threadId);
            if (existing._tag === "Some") return existing.value;

            const threadScope = yield* Scope.fork(
              scope,
              ExecutionStrategy.sequential,
            );

            const handle = yield* spawn(config, threadId).pipe(
              Effect.provide(transportMap.get(transport)),
              Effect.provide(spawnCtx),
              Effect.provideService(Scope.Scope, threadScope),
            );

            yield* Ref.update(threads, HashMap.set(threadId, handle));
            return handle;
          }).pipe(
            Effect.catchTag(
              "SqlError",
              (e) =>
                new OrchestratorError({
                  message: "Failed to spawn thread",
                  reason: "STORAGE_ERROR",
                  cause: e,
                }),
            ),
          );

        return Orchestrator.of({
          send: (transport, threadId, msg) =>
            Effect.gen(function* () {
              yield* store.getOrCreateThread(transport, threadId);
              const handle = yield* getOrSpawn(threadId, transport);
              yield* handle.send(msg);
            }).pipe(
              Effect.catchTag(
                "SqlError",
                (e) =>
                  new OrchestratorError({
                    message: "Failed to send message",
                    reason: "STORAGE_ERROR",
                    cause: e,
                  }),
              ),
            ),

          events: (transport, threadId) =>
            Effect.gen(function* () {
              yield* store.getOrCreateThread(transport, threadId);
              const map = yield* Ref.get(threads);
              const entry = HashMap.get(map, threadId);
              if (entry._tag === "None") return null;
              return entry.value.events;
            }).pipe(
              Effect.mapError(
                (e) =>
                  new OrchestratorError({
                    message: "Failed to get events",
                    reason: "STORAGE_ERROR",
                    cause: e,
                  }),
              ),
            ),
        });
      }),
    );
}
