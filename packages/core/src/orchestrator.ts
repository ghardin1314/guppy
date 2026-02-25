import { Actor } from "./actor";
import type { Store } from "./store";
import type { ActorMessage, AgentFactory, Settings } from "./types";

export interface OrchestratorOptions {
  store: Store;
  agentFactory: AgentFactory;
  settings?: Settings;
}

export class Orchestrator {
  private actors = new Map<string, Actor>();
  private store: Store;
  private agentFactory: AgentFactory;
  private settings: Settings;

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.agentFactory = options.agentFactory;
    this.settings = options.settings ?? options.store.getSettings();
  }

  send(threadId: string, message: ActorMessage): void {
    const actor = this.getOrCreateActor(threadId);
    actor.receive(message);
  }

  shutdown(): void {
    for (const actor of this.actors.values()) {
      actor.destroy();
    }
    this.actors.clear();
  }

  private getOrCreateActor(threadId: string): Actor {
    let actor = this.actors.get(threadId);
    if (!actor) {
      actor = new Actor(threadId, {
        store: this.store,
        agentFactory: this.agentFactory,
        settings: this.settings,
      });
      this.actors.set(threadId, actor);
    }
    return actor;
  }
}
