/**
 * TransportRegistry: mutable store where transports register during boot.
 *
 * Backed by a Ref<HashMap<string, Transport>>. Transports write to it
 * during Layer construction. TransportMap reads from it lazily when
 * threads are spawned.
 */

import { Context, Effect, HashMap, Layer, Ref, Schema } from "effect";
import type { TransportId } from "./schema.ts";
import type { Transport } from "./transport.ts";

// -- Service interface --------------------------------------------------------

export interface TransportRegistryService {
  readonly register: (
    name: TransportId,
    transport: Transport,
  ) => Effect.Effect<void>;
  readonly lookup: (
    name: TransportId,
  ) => Effect.Effect<Transport, TransportNotFoundError>;
}

// -- Tag ----------------------------------------------------------------------

export class TransportRegistry extends Context.Tag(
  "@guppy/core/TransportRegistry",
)<TransportRegistry, TransportRegistryService>() {
  static layer = Layer.effect(
    TransportRegistry,
    Effect.gen(function* () {
      const ref = yield* Ref.make(HashMap.empty<TransportId, Transport>());

      return TransportRegistry.of({
        register: (name, transport) =>
          Ref.update(ref, HashMap.set(name, transport)),

        lookup: (name) =>
          Effect.gen(function* () {
            const map = yield* Ref.get(ref);
            const t = HashMap.get(map, name);
            if (t._tag === "None") {
              return yield* new TransportNotFoundError({ name });
            }
            return t.value;
          }),
      });
    }),
  );
}

// -- Errors -------------------------------------------------------------------

export class TransportNotFoundError extends Schema.TaggedError<TransportNotFoundError>()(
  "TransportNotFoundError",
  { name: Schema.String },
) {}

// -- Live implementation ------------------------------------------------------
