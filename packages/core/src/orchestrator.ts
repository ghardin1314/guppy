import { Actor } from "./actor";
import type { CompactionDeps } from "./actor";
import { resolveThread } from "./resolve-thread";
import type { Store } from "./store";
import type { ActorMessage, AgentFactory, ChatHandle, EventTarget, Settings } from "./types";

export interface OrchestratorOptions {
  store: Store;
  agentFactory: AgentFactory;
  settings: Settings;
  chat: ChatHandle;
  compaction?: CompactionDeps;
}

export class Orchestrator {
  private actors = new Map<string, Actor>();
  private store: Store;
  private agentFactory: AgentFactory;
  private settings: Settings;
  private chat: ChatHandle;
  private compaction?: CompactionDeps;

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.agentFactory = options.agentFactory;
    this.settings = options.settings;
    this.chat = options.chat;
    this.compaction = options.compaction;
  }

  send(threadId: string, message: ActorMessage): void {
    const actor = this.getOrCreateActor(threadId);
    actor.receive(message);
  }

  /** Dispatch an event to a thread or channel. */
  dispatchEvent(target: EventTarget, text: string): void {
    if ("threadId" in target) {
      const thread = resolveThread(this.chat, target.threadId);
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

  private async postAndRoute(
    channelId: string,
    text: string
  ): Promise<void> {
    const sent = await this.chat
      .channel(channelId)
      .post(text);

    const thread = resolveThread(this.chat, sent.threadId);
    this.send(sent.threadId, { type: "prompt", text, thread, sentMessage: sent });
  }

  /**
   * Send a control message (abort/steer) to an existing actor.
   * Unlike send(), does NOT create an actor if none exists.
   */
  sendCommand(threadId: string, message: ActorMessage): boolean {
    const actor = this.actors.get(threadId);
    if (!actor) return false;
    actor.receive(message);
    return true;
  }

  /**
   * Broadcast a control message to all actors whose threadId starts with
   * the given channel prefix (e.g. "discord:123456:").
   * Returns the number of actors that received the message.
   */
  broadcastCommand(channelPrefix: string, message: ActorMessage): number {
    let count = 0;
    for (const [threadId, actor] of this.actors) {
      if (threadId.startsWith(channelPrefix)) {
        actor.receive(message);
        count++;
      }
    }
    return count;
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
        compaction: this.compaction,
      });
      this.actors.set(threadId, actor);
    }
    return actor;
  }
}
