import type { Message } from "chat";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type { Message } from "chat";
export type { AgentMessage } from "@mariozechner/pi-agent-core";

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
