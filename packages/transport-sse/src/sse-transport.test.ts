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
import { SseTransport, SseTransportLive, type SseEventMessage } from "./sse-transport.ts";
import { it } from "@guppy/core";

const tid = ThreadId.make;

// -- Mock SSE listener --------------------------------------------------------

function mockListener() {
  const messages: SseEventMessage[] = [];
  const send = (data: SseEventMessage) => {
    messages.push(data);
  };
  return { send, messages };
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

const SseLayer = Layer.provide(
  SseTransportLive,
  Layer.mergeAll(StoreLayer, RegistryLayer, OrchestratorLayer),
);

const TestLayer = Layer.mergeAll(
  StoreLayer,
  EchoAgentFactoryLive,
  OrchestratorLayer,
  SseLayer,
);

// -- Tests --------------------------------------------------------------------

it.layer(TestLayer)("SseTransport", (it) => {
  it.live("addListener registers and removeListener cleans up", () =>
    Effect.gen(function* () {
      const sse = yield* SseTransport;
      const listener = mockListener();

      yield* sse.addListener(tid("thread-1"), listener.send);
      yield* sse.removeListener(tid("thread-1"), listener.send);
      // Double remove is a no-op
      yield* sse.removeListener(tid("thread-1"), listener.send);
    }),
  );

  it.live("listener receives agent events after send", () =>
    Effect.gen(function* () {
      const sse = yield* SseTransport;
      const listener = mockListener();

      yield* sse.addListener(tid("thread-recv"), listener.send);
      yield* sse.send(tid("thread-recv"), {
        _tag: "Prompt",
        content: "hello",
      });

      yield* Effect.sleep("100 millis");

      const agentEvents = listener.messages.filter(
        (m) => m.type === "agent_event",
      );
      expect(agentEvents.length).toBeGreaterThan(0);
      expect(agentEvents[0]!.threadId).toBe("thread-recv");
    }),
  );

  it.live("listener on different thread does not receive events", () =>
    Effect.gen(function* () {
      const sse = yield* SseTransport;
      const listenerA = mockListener();
      const listenerB = mockListener();

      yield* sse.addListener(tid("thread-a"), listenerA.send);
      yield* sse.addListener(tid("thread-b"), listenerB.send);

      yield* sse.send(tid("thread-a"), {
        _tag: "Prompt",
        content: "only for A",
      });

      yield* Effect.sleep("100 millis");

      const aEvents = listenerA.messages.filter(
        (m) => m.type === "agent_event",
      );
      const bEvents = listenerB.messages.filter(
        (m) => m.type === "agent_event",
      );

      expect(aEvents.length).toBeGreaterThan(0);
      expect(bEvents.length).toBe(0);
    }),
  );

  it.live("multiple listeners on same thread all receive events", () =>
    Effect.gen(function* () {
      const sse = yield* SseTransport;
      const listenerA = mockListener();
      const listenerB = mockListener();

      yield* sse.addListener(tid("thread-multi"), listenerA.send);
      yield* sse.addListener(tid("thread-multi"), listenerB.send);

      yield* sse.send(tid("thread-multi"), {
        _tag: "Prompt",
        content: "broadcast",
      });

      yield* Effect.sleep("100 millis");

      const aEvents = listenerA.messages.filter(
        (m) => m.type === "agent_event",
      );
      const bEvents = listenerB.messages.filter(
        (m) => m.type === "agent_event",
      );

      expect(aEvents.length).toBeGreaterThan(0);
      expect(bEvents.length).toBeGreaterThan(0);
    }),
  );

  it.live("removed listener stops receiving events", () =>
    Effect.gen(function* () {
      const sse = yield* SseTransport;
      const listener = mockListener();

      yield* sse.addListener(tid("thread-rm"), listener.send);
      yield* sse.removeListener(tid("thread-rm"), listener.send);

      yield* sse.send(tid("thread-rm"), {
        _tag: "Prompt",
        content: "after remove",
      });

      yield* Effect.sleep("100 millis");

      const agentEvents = listener.messages.filter(
        (m) => m.type === "agent_event",
      );
      expect(agentEvents.length).toBe(0);
    }),
  );

  it.live("removing one listener keeps others active", () =>
    Effect.gen(function* () {
      const sse = yield* SseTransport;
      const stayListener = mockListener();
      const removeListener = mockListener();

      yield* sse.addListener(tid("thread-partial"), stayListener.send);
      yield* sse.addListener(tid("thread-partial"), removeListener.send);
      yield* sse.removeListener(tid("thread-partial"), removeListener.send);

      yield* sse.send(tid("thread-partial"), {
        _tag: "Prompt",
        content: "partial remove",
      });

      yield* Effect.sleep("100 millis");

      const stayEvents = stayListener.messages.filter(
        (m) => m.type === "agent_event",
      );
      const removeEvents = removeListener.messages.filter(
        (m) => m.type === "agent_event",
      );

      expect(stayEvents.length).toBeGreaterThan(0);
      expect(removeEvents.length).toBe(0);
    }),
  );
});
