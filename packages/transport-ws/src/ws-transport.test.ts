import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import {
  makeDbLayer,
  ThreadStoreLive,
  Orchestrator,
  TransportRegistryLive,
  TransportMap,
  EchoAgentFactoryLive,
  testConfig,
  ThreadId,
} from "@guppy/core";
import {
  WebsocketTransport,
  WebsocketTransportLive,
  type ServerMessage,
} from "./ws-transport.ts";
import { it } from "@guppy/core";

const tid = ThreadId.make;

// -- Mock WS client -----------------------------------------------------------

function mockClient() {
  const messages: ServerMessage[] = [];
  return {
    send(data: string) {
      messages.push(JSON.parse(data));
    },
    messages,
  };
}

// -- Layers -------------------------------------------------------------------

const DbLayer = makeDbLayer(":memory:");
const StoreLayer = Layer.provideMerge(ThreadStoreLive, DbLayer);
const RegistryLayer = TransportRegistryLive;
const TransportMapLayer = Layer.provide(
  TransportMap.DefaultWithoutDependencies,
  RegistryLayer,
);
const OrchestratorLayer = Layer.provide(
  Orchestrator.layer(testConfig),
  Layer.mergeAll(StoreLayer, EchoAgentFactoryLive, TransportMapLayer),
);

const WsLayer = Layer.provide(
  WebsocketTransportLive,
  Layer.mergeAll(StoreLayer, RegistryLayer, OrchestratorLayer),
);

const TestLayer = Layer.mergeAll(
  StoreLayer,
  EchoAgentFactoryLive,
  OrchestratorLayer,
  WsLayer,
);

// -- Tests --------------------------------------------------------------------

it.layer(TestLayer)("WebsocketTransport", (it) => {
  it.live("connect sends connected message", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-1", client);

      expect(client.messages).toHaveLength(1);
      expect(client.messages[0]).toEqual({
        type: "connected",
        channelId: "ch-1",
      });
    }),
  );

  it.live("disconnect after connect is idempotent", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-2", client);
      yield* ws.disconnect("ch-2");
      // second disconnect is a no-op
      yield* ws.disconnect("ch-2");
    }),
  );

  it.live("subscribe + deliver fans out to subscribed channel", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-3", client);
      yield* ws.subscribe("ch-3", tid("thread-1"));

      // Deliver via the registered transport
      yield* ws.send(tid("thread-1"), {
        _tag: "Prompt",
        content: "hello",
      });

      // Wait for echo agent + PubSub delivery
      yield* Effect.sleep("100 millis");

      const agentEvents = client.messages.filter(
        (m) => m.type === "agent_event",
      );
      expect(agentEvents.length).toBeGreaterThan(0);
      expect(agentEvents[0]!.threadId).toBeDefined();
    }),
  );

  it.live("unsubscribed channel does not receive events", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const subscribed = mockClient();
      const unsubscribed = mockClient();

      yield* ws.connect("ch-sub", subscribed);
      yield* ws.connect("ch-unsub", unsubscribed);

      yield* ws.subscribe("ch-sub", tid("thread-filter"));
      yield* ws.subscribe("ch-unsub", tid("thread-filter"));
      yield* ws.unsubscribe("ch-unsub", tid("thread-filter"));

      yield* ws.send(tid("thread-filter"), {
        _tag: "Prompt",
        content: "filter test",
      });

      yield* Effect.sleep("100 millis");

      const subEvents = subscribed.messages.filter(
        (m) => m.type === "agent_event",
      );
      const unsubEvents = unsubscribed.messages.filter(
        (m) => m.type === "agent_event",
      );

      expect(subEvents.length).toBeGreaterThan(0);
      expect(unsubEvents.length).toBe(0);
    }),
  );

  it.live("multiple channels subscribed to same thread both receive events", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const clientA = mockClient();
      const clientB = mockClient();

      yield* ws.connect("ch-a", clientA);
      yield* ws.connect("ch-b", clientB);

      yield* ws.subscribe("ch-a", tid("thread-multi"));
      yield* ws.subscribe("ch-b", tid("thread-multi"));

      yield* ws.send(tid("thread-multi"), {
        _tag: "Prompt",
        content: "broadcast",
      });

      yield* Effect.sleep("100 millis");

      const aEvents = clientA.messages.filter((m) => m.type === "agent_event");
      const bEvents = clientB.messages.filter((m) => m.type === "agent_event");

      expect(aEvents.length).toBeGreaterThan(0);
      expect(bEvents.length).toBeGreaterThan(0);
    }),
  );

  it.live("disconnected channel stops receiving events", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-dc", client);
      yield* ws.subscribe("ch-dc", tid("thread-dc"));
      yield* ws.disconnect("ch-dc");

      yield* ws.send(tid("thread-dc"), {
        _tag: "Prompt",
        content: "after disconnect",
      });

      yield* Effect.sleep("100 millis");

      const agentEvents = client.messages.filter(
        (m) => m.type === "agent_event",
      );
      expect(agentEvents.length).toBe(0);
    }),
  );

  it.live("handleMessage decodes subscribe", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-hm", client);
      yield* ws.handleMessage(
        "ch-hm",
        JSON.stringify({ type: "subscribe", threadId: "thread-hm" }),
      );

      // After subscribing via handleMessage, send should deliver
      yield* ws.send(tid("thread-hm"), {
        _tag: "Prompt",
        content: "via handleMessage",
      });

      yield* Effect.sleep("100 millis");

      const agentEvents = client.messages.filter(
        (m) => m.type === "agent_event",
      );
      expect(agentEvents.length).toBeGreaterThan(0);
    }),
  );

  it.live("handleMessage decodes prompt (auto-subscribes + sends)", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-prompt", client);
      yield* ws.handleMessage(
        "ch-prompt",
        JSON.stringify({
          type: "prompt",
          threadId: "thread-prompt",
          content: "hello from prompt",
        }),
      );

      yield* Effect.sleep("100 millis");

      const agentEvents = client.messages.filter(
        (m) => m.type === "agent_event",
      );
      expect(agentEvents.length).toBeGreaterThan(0);
    }),
  );

  it.live("handleMessage sends error on invalid JSON", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-err", client);
      yield* ws.handleMessage("ch-err", "not valid json!!!");

      const errors = client.messages.filter((m) => m.type === "error");
      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toBeDefined();
    }),
  );

  it.live("handleMessage sends error on unknown message type", () =>
    Effect.gen(function* () {
      const ws = yield* WebsocketTransport;
      const client = mockClient();

      yield* ws.connect("ch-unk", client);
      yield* ws.handleMessage(
        "ch-unk",
        JSON.stringify({ type: "bogus", threadId: "x" }),
      );

      const errors = client.messages.filter((m) => m.type === "error");
      expect(errors.length).toBe(1);
    }),
  );
});
