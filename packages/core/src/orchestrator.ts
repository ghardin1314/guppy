import { ThreadImpl, deriveChannelId } from "chat";
import type { Adapter, StateAdapter } from "chat";
import { Actor } from "./actor";
import type { Store } from "./store";
import type { ActorMessage, AgentFactory, EventTarget, Settings } from "./types";

/** Minimal Chat interface — mirrors Chat's public API. */
export interface ChatHandle {
  channel(
    channelId: string
  ): { post(text: string): Promise<{ threadId: string }> };
  getAdapter(name: string): Adapter;
  getState(): StateAdapter;
}

export interface OrchestratorOptions {
  store: Store;
  agentFactory: AgentFactory;
  settings: Settings;
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
    this.settings = options.settings;
    this.chat = options.chat;
  }

  send(threadId: string, message: ActorMessage): void {
    const actor = this.getOrCreateActor(threadId);
    actor.receive(message);
  }

  /** Dispatch an event to a thread or channel. */
  dispatchEvent(target: EventTarget, text: string): void {
    if ("threadId" in target) {
      const thread = this.resolveThread(target.threadId);
      this.send(target.threadId, { type: "prompt", text, thread });
    } else {
      this.postAndRoute(target.channelId, text).catch(
        (err) => {
          console.error("[Orchestrator] dispatchEvent failed:", err);
        }
      );
    }
  }

  /**
   * Post to a channel and route the resulting thread through the actor system.
   * Fire-and-forget — errors are logged, not thrown.
   */
  sendToChannel(channelId: string, text: string): void {
    this.postAndRoute(channelId, text).catch((err) => {
      console.error("[Orchestrator] sendToChannel failed:", err);
    });
  }

  private resolveThread(threadId: string): ThreadImpl {
    const adapterName = threadId.split(":")[0];
    const adapter = this.chat.getAdapter(adapterName);
    return new ThreadImpl({
      adapter,
      id: threadId,
      channelId: deriveChannelId(adapter, threadId),
      stateAdapter: this.chat.getState(),
      isDM: false,
    });
  }

  private async postAndRoute(
    channelId: string,
    text: string
  ): Promise<void> {
    const sentMessage = await this.chat
      .channel(channelId)
      .post(text);

    const thread = this.resolveThread(sentMessage.threadId);
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
