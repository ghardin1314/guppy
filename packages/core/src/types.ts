import type { Message, Thread } from "chat";
import type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";

export type { Message, Thread } from "chat";
export type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";

export interface LogEntry {
  date: string;
  messageId: string;
  userId: string;
  userName: string;
  text: string;
  isBot: boolean;
  attachments?: Array<{ original: string; local: string }>;
}

export interface Settings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  compaction?: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
  };
  idleTimeoutMs?: number;
  maxQueueDepth?: number;
}

export interface StoreOptions {
  dataDir: string;
}

export type ActorMessage =
  | { type: "prompt"; text: string; thread: Thread; message?: Message }
  | { type: "steer"; text: string }
  | { type: "abort" };

export interface ThreadMeta {
  adapterName: string;
  channelId: string;
  threadId: string;
  isDM: boolean;
}

export type AgentFactory = (threadId: string) => Agent;
