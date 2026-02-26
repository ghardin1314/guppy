import type { AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Message, Thread } from "chat";
import { join } from "node:path";
import { resolveThreadKeys } from "./encode";
import { EventBus } from "./events";
import { loadIdentity } from "./identity";
import { formatMemory } from "./memory";
import { Orchestrator } from "./orchestrator";
import { loadSkills } from "./skills";
import { Store } from "./store";
import type {
  ActorMessage,
  AgentFactory,
  ChatHandle,
  Settings,
  SystemPromptContext,
  ThreadMeta,
} from "./types";

// pi-agent-core types getApiKey as (provider: string) => ... but the runtime
// passes a Provider object { slug, name }. Handle both.
function defaultGetApiKey(
  provider: string | { slug: string },
): string | undefined {
  const slug = typeof provider === "string" ? provider : provider.slug;
  return process.env[`${slug.toUpperCase()}_API_KEY`];
}

export interface AgentConfig {
  model: Model<Api>;
  modelSettings?: { thinkingLevel?: ThinkingLevel };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: AgentTool<any>[];
  systemPrompt: string | ((ctx: SystemPromptContext) => string);
  getApiKey?: (provider: string) => string | undefined;
}

export interface GuppyOptions {
  dataDir: string;
  chat: ChatHandle;
  agent: AgentConfig;
  settings?: Settings;
}

/** Build the internal AgentFactory from declarative config. */
export function buildAgentFactory(
  dataDir: string,
  agent: AgentConfig,
): AgentFactory {
  return (thread: Thread) => {
    const { adapter, channelKey, threadKey } = resolveThreadKeys(
      thread.adapter,
      thread.id,
    );
    const meta: ThreadMeta = {
      adapterName: adapter,
      channelId: `${adapter}:${channelKey}`,
      threadId: thread.id,
      channelKey,
      threadKey,
      isDM: thread.isDM,
    };

    const ctx: SystemPromptContext = {
      identity: loadIdentity(dataDir),
      memory: formatMemory(dataDir, meta),
      skills: loadSkills(dataDir, meta),
      threadMeta: meta,
    };

    const systemPrompt =
      typeof agent.systemPrompt === "function"
        ? agent.systemPrompt(ctx)
        : agent.systemPrompt;

    return new Agent({
      initialState: {
        systemPrompt,
        model: agent.model,
        tools: agent.tools,
        thinkingLevel: agent.modelSettings?.thinkingLevel,
      },
      getApiKey: agent.getApiKey ?? defaultGetApiKey,
    });
  };
}

export class Guppy {
  readonly store: Store;
  readonly orchestrator: Orchestrator;
  readonly eventBus: EventBus;

  constructor(options: GuppyOptions) {
    const { dataDir, chat, agent, settings = {} } = options;

    this.store = new Store({
      dataDir,
      getAdapter: (name) => chat.getAdapter(name),
    });

    this.orchestrator = new Orchestrator({
      store: this.store,
      agentFactory: buildAgentFactory(dataDir, agent),
      settings,
      chat,
    });

    const eventsDir = join(dataDir, "events");
    this.eventBus = new EventBus(eventsDir, (target, formattedText) => {
      this.orchestrator.dispatchEvent(target, formattedText);
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

  sendToChannel(channelId: string, text: string): void {
    this.orchestrator.sendToChannel(channelId, text);
  }

  shutdown(): void {
    this.eventBus.stop();
    this.orchestrator.shutdown();
  }
}
