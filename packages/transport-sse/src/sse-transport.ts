/**
 * SseTransport: Effect Layer that bridges SSE connections to agent threads.
 *
 * Simpler than WebSocket transport — no channel IDs, no subscribe/unsubscribe.
 * Each SSE connection is scoped to a single thread via the URL:
 *   GET /events/:threadId
 *
 * The connection IS the subscription. Server tracks
 * Map<ThreadId, Set<SendFn>> — when an agent event fires for a thread,
 * it's written to all active SSE connections for that thread.
 */

import {
  AgentResponseEvent,
  Orchestrator,
  ThreadId,
  ThreadMessage,
  TransportId,
  TransportRegistry,
  type OrchestratorSendError,
} from "@guppy/core";
import {
  Clock,
  Context,
  Effect,
  Fiber,
  HashMap,
  HashSet,
  Layer,
  PubSub,
  Queue,
  Ref,
  Schema,
} from "effect";

// -- SSE event encoding -------------------------------------------------------

export const AgentEventMessage = Schema.Struct({
  type: Schema.Literal("agent_event"),
  threadId: Schema.String,
  event: AgentResponseEvent,
});

export type AgentEventMessage = Schema.Schema.Type<typeof AgentEventMessage>;

export const HeartbeatMessage = Schema.Struct({
  type: Schema.Literal("heartbeat"),
  timestamp: Schema.Number,
});
export type HeartbeatMessage = Schema.Schema.Type<typeof HeartbeatMessage>;

export const SseEventMessage = Schema.Union(
  AgentEventMessage,
  HeartbeatMessage,
);
export type SseEventMessage = Schema.Schema.Type<typeof SseEventMessage>;

// -- Internal types -----------------------------------------------------------

const SSE_TRANSPORT = TransportId.make("sse");

type SendFn = (data: SseEventMessage) => void;

interface ListenerState {
  readonly send: SendFn;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  readonly heartbeatFiber: Fiber.RuntimeFiber<void, never>;
}

// -- Service interface --------------------------------------------------------

export interface SseTransportService {
  /** Register an SSE listener for a thread. */
  readonly addListener: (
    threadId: ThreadId,
    send: SendFn,
  ) => Effect.Effect<void>;

  /** Remove an SSE listener (on disconnect). */
  readonly removeListener: (
    threadId: ThreadId,
    send: SendFn,
  ) => Effect.Effect<void>;

  /** Send a message to the orchestrator for a thread. */
  readonly send: (
    threadId: ThreadId,
    msg: ThreadMessage,
  ) => Effect.Effect<void, OrchestratorSendError>;
}

// -- Tag ----------------------------------------------------------------------

export class SseTransport extends Context.Tag(
  "@guppy/transport-sse/SseTransport",
)<SseTransport, SseTransportService>() {}

// -- Live implementation ------------------------------------------------------

export const SseTransportLive = Layer.scoped(
  SseTransport,
  Effect.gen(function* () {
    const registry = yield* TransportRegistry;
    const orchestrator = yield* Orchestrator;
    const scope = yield* Effect.scope;

    // ThreadId → set of active listeners (each with its own PubSub fiber)
    const listenersRef = yield* Ref.make(
      HashMap.empty<ThreadId, HashSet.HashSet<ListenerState>>(),
    );
    const pubsub = yield* PubSub.unbounded<SseEventMessage>();

    // -- Register "sse" transport with core ------------------------------------

    yield* registry.register(SSE_TRANSPORT, {
      getContext: () => Effect.succeed(""),
      deliver: (threadId, event) =>
        PubSub.publish(pubsub, {
          type: "agent_event",
          threadId,
          event,
        }),
    });

    // -- Service --------------------------------------------------------------

    return SseTransport.of({
      addListener: (threadId, send) =>
        Effect.gen(function* () {
          // Fork a daemon fiber that subscribes to PubSub and filters for this thread
          const fiber = yield* Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(pubsub);
            return yield* Effect.forever(
              Effect.gen(function* () {
                const msg = yield* Queue.take(queue);
                if (msg.type === "agent_event" && msg.threadId !== threadId) return;
                yield* Effect.try(() => send(msg)).pipe(
                  Effect.catchAll(() => Effect.void),
                );
              }),
            );
          }).pipe(Effect.scoped, Effect.forkIn(scope));

          const heartbeatFiber = yield* Effect.forever(
            Effect.gen(function* () {
              yield* Effect.sleep("3 seconds");
              const now = yield* Clock.currentTimeMillis;
              yield* Effect.try(() =>
                send({ type: "heartbeat", timestamp: now }),
              ).pipe(Effect.catchAll(() => Effect.void));
            }),
          ).pipe(Effect.forkIn(scope));

          const state: ListenerState = { send, fiber, heartbeatFiber };
          yield* Ref.update(listenersRef, (m) => {
            const existing = HashMap.get(m, threadId);
            const set =
              existing._tag === "Some"
                ? HashSet.add(existing.value, state)
                : HashSet.make(state);
            return HashMap.set(m, threadId, set);
          });
        }),

      removeListener: (threadId, send) =>
        Effect.gen(function* () {
          const listeners = yield* Ref.get(listenersRef);
          const set = HashMap.get(listeners, threadId);
          if (set._tag === "None") return;

          // Find the listener with matching send function
          let found: ListenerState | undefined;
          for (const ls of set.value) {
            if (ls.send === send) {
              found = ls;
              break;
            }
          }
          if (!found) return;

          yield* Fiber.interrupt(found.fiber);
          yield* Fiber.interrupt(found.heartbeatFiber);
          const newSet = HashSet.remove(set.value, found);
          yield* Ref.update(listenersRef, (m) =>
            HashSet.size(newSet) === 0
              ? HashMap.remove(m, threadId)
              : HashMap.set(m, threadId, newSet),
          );
        }),

      send: (threadId, msg) => orchestrator.send(SSE_TRANSPORT, threadId, msg),
    });
  }),
);
