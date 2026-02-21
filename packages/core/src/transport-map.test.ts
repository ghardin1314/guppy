import { expect } from "bun:test";
import { Effect, Layer } from "effect";
import { it } from "./testing.ts";
import { TransportService, type Transport } from "./transport.ts";
import {
  TransportRegistry,
  TransportNotFoundError,
} from "./transport-registry.ts";
import { TransportMap } from "./transport-map.ts";
import { TransportId, ThreadId } from "./schema.ts";

// -- Layers -------------------------------------------------------------------

const RegistryLayer = TransportRegistry.layer;
const TransportMapLayer = Layer.provide(
  TransportMap.DefaultWithoutDependencies,
  RegistryLayer,
);
const TestLayer = Layer.mergeAll(TransportMapLayer, RegistryLayer);

// -- Tests --------------------------------------------------------------------

it.layer(TestLayer)("transport-map", (it) => {
  it.live("get returns valid TransportService for registered transport", () =>
    Effect.gen(function* () {
      const registry = yield* TransportRegistry;
      const transportMap = yield* TransportMap;

      const t: Transport = {
        getContext: () => Effect.succeed("map-context"),
        deliver: () => Effect.void,
      };
      yield* registry.register(TransportId.make("mapped"), t);

      const transport = yield* TransportService.pipe(
        Effect.provide(transportMap.get(TransportId.make("mapped"))),
      );
      const ctx = yield* transport.getContext(ThreadId.make("t1"));
      expect(ctx).toBe("map-context");
    }),
  );

  it.live("get with unknown name fails with TransportNotFoundError", () =>
    Effect.gen(function* () {
      const transportMap = yield* TransportMap;

      const error = yield* TransportService.pipe(
        Effect.provide(transportMap.get(TransportId.make("ghost"))),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(TransportNotFoundError);
    }),
  );
});
