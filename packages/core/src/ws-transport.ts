/**
 * WebsocketTransport: Effect Layer that bridges WebSocket channels to agent threads.
 *
 * Concepts:
 *   - Channel = WebSocket connection (ephemeral)
 *   - Thread  = conversation (persistent)
 *   - A single PubSub broadcasts all agent events; each channel's fiber filters
 *     by its own subscription set before forwarding upstream.
 *
 * Registers "web" transport with TransportRegistry at construction time.
 * Owns all WS protocol serialization — callers pass raw strings.
 */

import { Context, Effect, Fiber, flow, HashMap, HashSet, Layer, PubSub, Queue, Ref, Schema } from "effect";
import { Orchestrator, type OrchestratorSendError } from "./orchestrator.ts";
import { ThreadMessage } from "./thread-message.ts";
import { TransportRegistry } from "./transport-registry.ts";
import { ThreadId, TransportId } from "./schema.ts";

// -- WS protocol schemas ------------------------------------------------------

export const SubscribeMessage = Schema.Struct({
  type: Schema.Literal("subscribe"),
  threadId: Schema.String,
});

export const UnsubscribeMessage = Schema.Struct({
  type: Schema.Literal("unsubscribe"),
  threadId: Schema.String,
});

export const PromptMessage = Schema.Struct({
  type: Schema.Literal("prompt"),
  threadId: Schema.String,
  content: Schema.String,
});

export const SteerMessage = Schema.Struct({
  type: Schema.Literal("steer"),
  threadId: Schema.String,
  content: Schema.String,
});

export const StopMessage = Schema.Struct({
  type: Schema.Literal("stop"),
  threadId: Schema.String,
});

export const ClientMessage = Schema.Union(
  SubscribeMessage,
  UnsubscribeMessage,
  PromptMessage,
  SteerMessage,
  StopMessage,
);
export type ClientMessage = Schema.Schema.Type<typeof ClientMessage>;

export const ConnectedMessage = Schema.Struct({
  type: Schema.Literal("connected"),
  channelId: Schema.String,
});

export const AgentEventMessage = Schema.Struct({
  type: Schema.Literal("agent_event"),
  threadId: Schema.String,
  event: Schema.Unknown,
});

export const ErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
});

export const ServerMessage = Schema.Union(
  ConnectedMessage,
  AgentEventMessage,
  ErrorMessage,
);
export type ServerMessage = Schema.Schema.Type<typeof ServerMessage>;

// -- Broadcast message (pre-encoded, published to PubSub) --------------------

interface BroadcastMessage {
  readonly threadId: ThreadId;
  readonly data: string;
}

// -- Channel state ------------------------------------------------------------

const WS_TRANSPORT = TransportId.make("ws");

interface ChannelState {
  readonly send: (data: string) => void;
  readonly subscriptions: HashSet.HashSet<ThreadId>;
  readonly fiber: Fiber.RuntimeFiber<void, never>;
}

// -- Internal helpers ---------------------------------------------------------

const decodeClientMessage = Schema.decode(Schema.parseJson(ClientMessage));

const encodeServerMessage = flow(
  Schema.encode(Schema.parseJson(ServerMessage)),
  Effect.either,
);

// -- Service interface --------------------------------------------------------

export interface WebsocketTransportService {
  /** Register channel, send "connected" message. */
  readonly connect: (
    channelId: string,
    client: { send(data: string): void },
  ) => Effect.Effect<void>;

  readonly disconnect: (channelId: string) => Effect.Effect<void>;

  /** Decode raw WS message string + dispatch. */
  readonly handleMessage: (
    channelId: string,
    raw: string,
  ) => Effect.Effect<void>;

  readonly subscribe: (
    channelId: string,
    threadId: ThreadId,
  ) => Effect.Effect<void>;

  readonly unsubscribe: (
    channelId: string,
    threadId: ThreadId,
  ) => Effect.Effect<void>;

  readonly send: (
    threadId: ThreadId,
    msg: ThreadMessage,
  ) => Effect.Effect<void, OrchestratorSendError>;
}

// -- Tag ----------------------------------------------------------------------

export class WebsocketTransport extends Context.Tag(
  "@guppy/core/WebsocketTransport",
)<WebsocketTransport, WebsocketTransportService>() {}

// -- Live implementation ------------------------------------------------------

export const WebsocketTransportLive = Layer.scoped(
  WebsocketTransport,
  Effect.gen(function* () {
    const registry = yield* TransportRegistry;
    const orchestrator = yield* Orchestrator;
    const scope = yield* Effect.scope;

    const channelsRef = yield* Ref.make(HashMap.empty<string, ChannelState>());
    const pubsub = yield* PubSub.unbounded<BroadcastMessage>();

    // -- Internal: send encoded ServerMessage to a single channel -------------

    const sendToChannel = (channelId: string, msg: ServerMessage) =>
      Effect.gen(function* () {
        const channels = yield* Ref.get(channelsRef);
        const ch = HashMap.get(channels, channelId);
        if (ch._tag === "None") return;
        const json = yield* encodeServerMessage(msg);
        if (json._tag === "Left") return;
        yield* Effect.try(() => ch.value.send(json.right)).pipe(
          Effect.catchAll(() => Effect.void),
        );
      });

    // -- Register "web" transport ---------------------------------------------

    yield* registry.register(WS_TRANSPORT, {
      getContext: () => Effect.succeed(""),
      deliver: (threadId, event) =>
        Effect.gen(function* () {
          const json = yield* encodeServerMessage({
            type: "agent_event",
            threadId,
            event,
          });
          if (json._tag === "Left") return;
          yield* PubSub.publish(pubsub, { threadId, data: json.right });
        }),
    });

    // -- subscribe / unsubscribe internals ------------------------------------

    const subscribeImpl = (channelId: string, threadId: ThreadId) =>
      Ref.update(channelsRef, (m) => {
        const ch = HashMap.get(m, channelId);
        if (ch._tag === "None") return m;
        return HashMap.set(m, channelId, {
          ...ch.value,
          subscriptions: HashSet.add(ch.value.subscriptions, threadId),
        });
      });

    const unsubscribeImpl = (channelId: string, threadId: ThreadId) =>
      Ref.update(channelsRef, (m) => {
        const ch = HashMap.get(m, channelId);
        if (ch._tag === "None") return m;
        return HashMap.set(m, channelId, {
          ...ch.value,
          subscriptions: HashSet.remove(ch.value.subscriptions, threadId),
        });
      });

    const sendImpl = (threadId: ThreadId, msg: ThreadMessage) =>
      orchestrator.send(WS_TRANSPORT, threadId, msg);

    // -- Service --------------------------------------------------------------

    return WebsocketTransport.of({
      connect: (channelId, client) =>
        Effect.gen(function* () {
          const sendFn = client.send.bind(client);

          // Fork a daemon fiber: subscribe to PubSub, filter by this channel's subscriptions
          const fiber = yield* Effect.gen(function* () {
            const queue = yield* PubSub.subscribe(pubsub);
            return yield* Effect.forever(
              Effect.gen(function* () {
                const msg = yield* Queue.take(queue);
                const channels = yield* Ref.get(channelsRef);
                const ch = HashMap.get(channels, channelId);
                if (ch._tag === "None") return;
                if (!HashSet.has(ch.value.subscriptions, msg.threadId)) return;
                yield* Effect.try(() => sendFn(msg.data)).pipe(
                  Effect.catchAll(() => Effect.void),
                );
              }),
            );
          }).pipe(Effect.scoped, Effect.forkIn(scope));

          const state: ChannelState = { send: sendFn, subscriptions: HashSet.empty<ThreadId>(), fiber };
          yield* Ref.update(channelsRef, HashMap.set(channelId, state));

          yield* sendToChannel(channelId, {
            type: "connected",
            channelId,
          });
        }),

      disconnect: (channelId) =>
        Effect.gen(function* () {
          const channels = yield* Ref.get(channelsRef);
          const ch = HashMap.get(channels, channelId);
          if (ch._tag === "None") return;

          yield* Fiber.interrupt(ch.value.fiber);
          yield* Ref.update(channelsRef, HashMap.remove(channelId));
        }),

      handleMessage: (channelId, raw) =>
        Effect.gen(function* () {
          const msg = yield* decodeClientMessage(raw);
          const tid = ThreadId.make(msg.threadId);

          switch (msg.type) {
            case "subscribe":
              yield* subscribeImpl(channelId, tid);
              break;
            case "unsubscribe":
              yield* unsubscribeImpl(channelId, tid);
              break;
            case "prompt":
              yield* subscribeImpl(channelId, tid);
              yield* sendImpl(
                tid,
                ThreadMessage.Prompt({ content: msg.content }),
              );
              break;
            case "steer":
              yield* sendImpl(
                tid,
                ThreadMessage.Steering({ content: msg.content }),
              );
              break;
            case "stop":
              yield* sendImpl(tid, ThreadMessage.Stop());
              break;
          }
        }).pipe(
          Effect.catchAll((e) =>
            sendToChannel(channelId, {
              type: "error",
              message: e instanceof Error ? e.message : String(e),
            }),
          ),
        ),

      subscribe: subscribeImpl,
      unsubscribe: unsubscribeImpl,
      send: sendImpl,
    });
  }),
);
