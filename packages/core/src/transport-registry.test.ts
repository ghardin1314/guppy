import { expect } from "bun:test";
import { Effect } from "effect";
import { it } from "./testing.ts";
import {
  TransportRegistry,
  TransportRegistryLive,
  TransportNotFoundError,
} from "./transport-registry.ts";
import type { Transport } from "./transport.ts";

// -- Helpers ------------------------------------------------------------------

const dummyTransport = (label: string): Transport => ({
  getContext: () => Effect.succeed(label),
  deliver: () => Effect.void,
});

// -- Tests --------------------------------------------------------------------

it.layer(TransportRegistryLive)("transport-registry", (it) => {
  it.live("lookup unknown name fails with TransportNotFoundError", () =>
    Effect.gen(function* () {
      const registry = yield* TransportRegistry;

      const error = yield* registry.lookup("nope").pipe(Effect.flip);

      expect(error).toBeInstanceOf(TransportNotFoundError);
      expect(error.name).toBe("nope");
    }),
  );

  it.live("register and lookup succeeds", () =>
    Effect.gen(function* () {
      const registry = yield* TransportRegistry;
      const t = dummyTransport("slack");
      yield* registry.register("slack", t);

      const result = yield* registry.lookup("slack");
      expect(result).toBe(t);
    }),
  );

  it.live("register multiple transports and lookup each", () =>
    Effect.gen(function* () {
      const registry = yield* TransportRegistry;
      const t1 = dummyTransport("a");
      const t2 = dummyTransport("b");
      yield* registry.register("a", t1);
      yield* registry.register("b", t2);

      expect(yield* registry.lookup("a")).toBe(t1);
      expect(yield* registry.lookup("b")).toBe(t2);
    }),
  );

  it.live("overwriting a registration replaces the transport", () =>
    Effect.gen(function* () {
      const registry = yield* TransportRegistry;
      const v1 = dummyTransport("v1");
      const v2 = dummyTransport("v2");
      yield* registry.register("overwrite-me", v1);
      yield* registry.register("overwrite-me", v2);

      const result = yield* registry.lookup("overwrite-me");
      expect(result).toBe(v2);
    }),
  );
});
