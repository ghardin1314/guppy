/**
 * Guppy: the membrane between Effect's managed runtime and plain TypeScript.
 *
 * Owns a ManagedRuntime composing all core layers, exposes plain TS methods
 * (no Effect types leak), and supports `.register()` for transport layers.
 */

import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime } from "effect";
import type { AgentThreadConfig } from "./agent-thread.ts";
import { AgentFactory, PiAgentFactoryLive } from "./agent.ts";
import { makeDbLayer } from "./db.ts";
import { EventBus, EventBusLive } from "./event-bus.ts";
import { EventStore, EventStoreLive } from "./event-store.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ThreadStore, ThreadStoreLive } from "./repository.ts";
import type { EventSchedule, GuppyEvent, ScheduleTiming } from "./schema.ts";
import { TransportMap } from "./transport-map.ts";
import {
  TransportRegistry,
  TransportRegistryLive,
} from "./transport-registry.ts";

// -- Config -------------------------------------------------------------------

export interface GuppyConfig {
  projectDir: string;
  agent: AgentThreadConfig;
  /** Override db path, or ":memory:" for in-memory. Default: projectDir/.guppy/guppy.db */
  db?: string;
}

// -- CoreServices -------------------------------------------------------------

export type CoreServices =
  | Orchestrator
  | EventBus
  | EventStore
  | ThreadStore
  | TransportRegistry
  | TransportMap
  | AgentFactory
  | SqlClient.SqlClient;

// -- Layer composition --------------------------------------------------------

function makeCoreLive(
  config: GuppyConfig,
  agentFactoryLayer: Layer.Layer<AgentFactory>,
) {
  const dbPath = config.db ?? `${config.projectDir}/.guppy/guppy.db`;
  const DbLayer = makeDbLayer(dbPath);

  const StoreLayer = Layer.provideMerge(ThreadStoreLive, DbLayer);
  const EventStoreLayer = Layer.provideMerge(EventStoreLive, DbLayer);

  const RegistryLayer = TransportRegistryLive;
  const TransportMapLayer = Layer.provide(
    TransportMap.DefaultWithoutDependencies,
    RegistryLayer,
  );

  const OrchestratorLayer = Layer.provide(
    Orchestrator.layer(config.agent),
    Layer.mergeAll(StoreLayer, agentFactoryLayer, TransportMapLayer),
  );

  const EventBusLayer = Layer.provide(EventBusLive, EventStoreLayer);

  return Layer.mergeAll(
    DbLayer,
    StoreLayer,
    EventStoreLayer,
    RegistryLayer,
    TransportMapLayer,
    agentFactoryLayer,
    OrchestratorLayer,
    EventBusLayer,
  );
}

// -- Guppy class --------------------------------------------------------------

export class Guppy<Extra = never> {
  private readonly config: GuppyConfig;
  private readonly agentFactoryLayer: Layer.Layer<AgentFactory>;
  private accumulated: Layer.Layer<Extra, unknown, CoreServices>;
  private runtime: ManagedRuntime.ManagedRuntime<
    CoreServices | Extra,
    unknown
  > | null = null;

  private constructor(
    config: GuppyConfig,
    agentFactoryLayer: Layer.Layer<AgentFactory>,
    accumulated: Layer.Layer<Extra, unknown, CoreServices>,
  ) {
    this.config = config;
    this.agentFactoryLayer = agentFactoryLayer;
    this.accumulated = accumulated;
  }

  static create(config: GuppyConfig): Guppy {
    return new Guppy(
      config,
      PiAgentFactoryLive,
      Layer.empty as Layer.Layer<never>,
    );
  }

  /** @internal — test-only: override the agent factory layer */
  static _createWithFactory(
    config: GuppyConfig,
    agentFactoryLayer: Layer.Layer<AgentFactory>,
  ): Guppy {
    return new Guppy(
      config,
      agentFactoryLayer,
      Layer.empty as Layer.Layer<never>,
    );
  }

  register<T>(layer: Layer.Layer<T, unknown, CoreServices>): Guppy<Extra | T> {
    const next = new Guppy<Extra | T>(
      this.config,
      this.agentFactoryLayer,
      // Merge existing accumulated with new layer
      Layer.mergeAll(
        this.accumulated as Layer.Layer<Extra, unknown, CoreServices>,
        layer as Layer.Layer<T, unknown, CoreServices>,
      ) as Layer.Layer<Extra | T, unknown, CoreServices>,
    );
    return next;
  }

  async boot(): Promise<void> {
    if (this.runtime) throw new Error("Guppy already booted");

    // Ensure .guppy dir exists (skip for :memory:)
    const dbPath = this.config.db;
    if (dbPath !== ":memory:") {
      const { mkdir } = await import("fs/promises");
      await mkdir(`${this.config.projectDir}/.guppy`, { recursive: true });
    }

    const coreLive = makeCoreLive(this.config, this.agentFactoryLayer);

    // Provide core services to accumulated transport layers
    const provided = Layer.provide(this.accumulated, coreLive);

    // Merge core + provided transport layers into final layer
    const main = Layer.mergeAll(coreLive, provided);

    this.runtime = ManagedRuntime.make(main);

    // Eagerly construct layers
    await this.runtime.runPromise(Effect.void);
  }

  emit(event: GuppyEvent): void {
    if (!this.runtime) throw new Error("Guppy not booted");
    this.runtime.runFork(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.emit(event);
      }),
    );
  }

  async schedule(
    event: GuppyEvent,
    timing: ScheduleTiming,
  ): Promise<EventSchedule> {
    if (!this.runtime) throw new Error("Guppy not booted");
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const bus = yield* EventBus;
        return yield* bus.schedule(event, timing);
      }),
    );
  }

  /** Access a core service from the runtime. For advanced/transport use. */
  runEffect<A, E>(
    effect: Effect.Effect<A, E, CoreServices | Extra>,
  ): Promise<A> {
    if (!this.runtime) throw new Error("Guppy not booted");
    return this.runtime.runPromise(
      effect as Effect.Effect<A, E, CoreServices | Extra>,
    );
  }

  async shutdown(): Promise<void> {
    if (!this.runtime) return;
    await this.runtime.dispose();
    this.runtime = null;
  }
}
