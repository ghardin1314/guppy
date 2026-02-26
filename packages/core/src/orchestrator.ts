import { ThreadImpl } from "chat";
import { Actor } from "./actor";
import type { Store } from "./store";
import type { ActorMessage, AgentFactory, Settings } from "./types";

/** Minimal Chat interface — avoids coupling to Chat's full generic signature. */
export interface ChatHandle {
  channel(
    channelId: string
  ): { post(text: string): Promise<{ threadId: string }> };
}

export interface OrchestratorOptions {
  store: Store;
  agentFactory: AgentFactory;
  settings?: Settings;
  chat: ChatHandle;
}

export class Orchestrator {
  private actors = new Map<string, Actor>();
  private store: Store;
  private agentFactory: AgentFactory;
  private settings: Settings;
  private chat: ChatHandle;

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.agentFactory = options.agentFactory;
    this.settings = options.settings ?? options.store.getSettings();
    this.chat = options.chat;
  }

  send(threadId: string, message: ActorMessage): void {
    const actor = this.getOrCreateActor(threadId);
    actor.receive(message);
  }

  /**
   * Post to a channel and route the resulting thread through the actor system.
   * Fire-and-forget — errors are logged, not thrown.
   */
  sendToChannel(adapterId: string, channelId: string, text: string): void {
    this.postAndRoute(adapterId, channelId, text).catch((err) => {
      console.error("[Orchestrator] sendToChannel failed:", err);
    });
  }

  private async postAndRoute(
    adapterId: string,
    channelId: string,
    text: string
  ): Promise<void> {
    const compositeChannelId = `${adapterId}:${channelId}`;

    const sentMessage = await this.chat
      .channel(compositeChannelId)
      .post(text);

    const thread = new ThreadImpl({
      adapterName: adapterId,
      id: sentMessage.threadId,
      channelId: compositeChannelId,
      isDM: false,
    });

    this.send(sentMessage.threadId, { type: "prompt", text, thread });
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
