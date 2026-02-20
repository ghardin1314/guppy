/**
 * TransportMap: LayerMap-backed lazy lookup of transports by name.
 *
 * Agent threads access their transport via:
 *   Effect.provide(TransportMap.get(transportName))
 *
 * Lookups happen at thread spawn time, after all transports have registered.
 */

import { Effect, Layer, LayerMap } from "effect";
import { TransportService } from "./transport.ts";
import {
  TransportRegistry,
  TransportRegistryLive,
} from "./transport-registry.ts";
import type { TransportId } from "./schema.ts";

// -- Service ------------------------------------------------------------------

export class TransportMap extends LayerMap.Service<TransportMap>()(
  "@guppy/core/TransportMap",
  {
    lookup: (name: TransportId) =>
      Layer.effect(
        TransportService,
        Effect.gen(function* () {
          const registry = yield* TransportRegistry;
          return yield* registry.lookup(name);
        }),
      ),
    dependencies: [TransportRegistryLive],
  },
) {}
