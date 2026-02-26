import { join } from "node:path";
import { Store } from "./store";
import { Orchestrator, type ChatHandle } from "./orchestrator";
import { EventBus } from "./events";
import type { Message } from "chat";
import type { ActorMessage, AgentFactory, Settings } from "./types";

export interface GuppyOptions {
  dataDir: string;
  agentFactory: AgentFactory;
  settings: Settings;
  chat: ChatHandle;
}

export class Guppy {
  readonly store: Store;
  readonly orchestrator: Orchestrator;
  readonly eventBus: EventBus;

  constructor(options: GuppyOptions) {
    this.store = new Store({ dataDir: options.dataDir });

    this.orchestrator = new Orchestrator({
      store: this.store,
      agentFactory: options.agentFactory,
      settings: options.settings,
      chat: options.chat,
    });

    const eventsDir = join(options.dataDir, "events");
    this.eventBus = new EventBus(eventsDir, (target, formattedText) => {
      if ("threadId" in target) {
        this.orchestrator.send(target.threadId, {
          type: "prompt",
          text: formattedText,
          thread: null!,
        });
      } else {
        this.orchestrator.sendToChannel(
          target.adapterId,
          target.channelId,
          formattedText
        );
      }
    });

    this.eventBus.start();
  }

  send(threadId: string, message: ActorMessage): void {
    this.orchestrator.send(threadId, message);
  }

  /** Full log + attachment download — use for active threads. */
  async logMessage(threadId: string, message: Message): Promise<void> {
    await this.store.logMessage(threadId, message);
  }

  /** Lightweight log, no attachment download — use for passive/background messages. */
  logPassiveMessage(threadId: string, message: Message): void {
    this.store.logChannelMessage(threadId, message);
  }

  sendToChannel(adapterId: string, channelId: string, text: string): void {
    this.orchestrator.sendToChannel(adapterId, channelId, text);
  }

  shutdown(): void {
    this.eventBus.stop();
    this.orchestrator.shutdown();
  }
}
