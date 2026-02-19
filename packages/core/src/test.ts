/**
 * Thin wrapper around bun:test providing ergonomic Effect test runners.
 * Mirrors the core @effect/vitest API (it.effect, it.scoped, it.live, it.layer)
 * but runs on bun:test so bun:sqlite works.
 */

import { test, describe } from "bun:test";
import { Effect, Layer, Scope, TestClock, TestServices } from "effect";

type EffectFn<R> = () => Effect.Effect<void, unknown, R>;

interface Tester<R> {
  (name: string, fn: EffectFn<R>, timeout?: number): void;
  skip: (name: string, fn: EffectFn<R>, timeout?: number) => void;
  only: (name: string, fn: EffectFn<R>, timeout?: number) => void;
}

export interface Methods<R = never> {
  readonly effect: Tester<TestServices.TestServices | TestClock.TestClock | R>;
  readonly scoped: Tester<TestServices.TestServices | TestClock.TestClock | Scope.Scope | R>;
  readonly live: Tester<R>;
  readonly layer: <R2, E>(
    layer: Layer.Layer<R2, E, R>,
  ) => {
    (f: (it: Methods<R | R2>) => void): void;
    (name: string, f: (it: Methods<R | R2>) => void): void;
  };
}

const TestServicesLayer = Layer.provideMerge(
  TestClock.defaultTestClock,
  Layer.effectContext(Effect.sync(() => TestServices.liveServices)),
);

function runEffect<R>(
  effect: Effect.Effect<void, unknown, R>,
  layer: Layer.Layer<R>,
): Promise<void> {
  return Effect.provide(effect, layer).pipe(Effect.runPromise) as Promise<void>;
}

function makeTester<R>(layer: Layer.Layer<R>): Tester<R> {
  const tester = ((name: string, fn: EffectFn<R>, timeout?: number) => {
    test(name, () => runEffect(fn(), layer), timeout);
  }) as Tester<R>;

  tester.skip = (name, fn, timeout) => {
    test.skip(name, () => runEffect(fn(), layer), timeout);
  };

  tester.only = (name, fn, timeout) => {
    test.only(name, () => runEffect(fn(), layer), timeout);
  };

  return tester;
}

function makeMethods<R>(baseLayer: Layer.Layer<R>): Methods<R> {
  const withTestServices = Layer.merge(
    baseLayer,
    TestServicesLayer,
  ) as Layer.Layer<TestServices.TestServices | TestClock.TestClock | R>;

  const withScope = Layer.merge(
    withTestServices,
    Layer.scope,
  ) as Layer.Layer<TestServices.TestServices | TestClock.TestClock | Scope.Scope | R>;

  return {
    effect: makeTester(withTestServices),
    scoped: makeTester(withScope),
    live: makeTester(baseLayer),
    layer: <R2, E>(layer: Layer.Layer<R2, E, R>) => {
      const combined = Layer.merge(
        baseLayer,
        Layer.provide(layer, baseLayer),
      ) as Layer.Layer<R | R2>;

      return (...args: [string, (it: Methods<R | R2>) => void] | [(it: Methods<R | R2>) => void]) => {
        const [name, fn] = args.length === 2 ? args : [undefined, args[0]];
        const inner = () => fn(makeMethods(combined));
        if (name) {
          describe(name, inner);
        } else {
          inner();
        }
      };
    },
  };
}

/**
 * Effect-aware test helpers for bun:test.
 *
 * ```ts
 * import { it } from "./test.ts";
 * import { Effect } from "effect";
 *
 * it.effect("works", () =>
 *   Effect.gen(function* () {
 *     expect(1 + 1).toBe(2);
 *   })
 * );
 *
 * it.layer(MyDbLayer)("with db", (it) => {
 *   it.effect("queries", () =>
 *     Effect.gen(function* () {
 *       const sql = yield* SqlClient;
 *       // ...
 *     })
 *   );
 * });
 * ```
 */
export const it: Methods = makeMethods(Layer.empty);
