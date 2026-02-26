import type { Message, Thread } from "chat";
import type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";

export type { Message, Thread } from "chat";
export type { Agent, AgentMessage } from "@mariozechner/pi-agent-core";

export interface LogEntry {
  date: string;
  messageId: string;
  threadId?: string;
  userId: string;
  userName: string;
  text: string;
  isBot: boolean;
  attachments?: Array<{ original: string; local: string; mimeType?: string }>;
}

// TODO: How much of this are we actually using?
export interface Settings {
  defaultProvider: string;
  defaultModel: string;
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

import type { ChannelKey, ThreadKey } from "./encode";

export interface ThreadMeta {
  adapterName: string;
  channelId: string;   // composite, e.g. "slack:C123ABC"
  threadId: string;    // composite, e.g. "slack:C123ABC:1234567890.123456"
  channelKey: ChannelKey;
  threadKey: ThreadKey;
  isDM: boolean;
}

export type AgentFactory = (thread: Thread) => Agent;

// -- Event bus types --

import { type Static, Type } from "@sinclair/typebox";

const ThreadTargetSchema = Type.Object({
  threadId: Type.String(),
});

const ChannelTargetSchema = Type.Object({
  channelId: Type.String(),
});

const EventTargetSchema = Type.Union([ThreadTargetSchema, ChannelTargetSchema]);

const ImmediateEventSchema = Type.Object({
  type: Type.Literal("immediate"),
  text: Type.String(),
});

const OneShotEventSchema = Type.Object({
  type: Type.Literal("one-shot"),
  text: Type.String(),
  at: Type.String(), // ISO 8601 with offset, e.g. "2025-12-15T09:00:00+01:00"
});

const PeriodicEventSchema = Type.Object({
  type: Type.Literal("periodic"),
  text: Type.String(),
  schedule: Type.String(),
  timezone: Type.String(),
});

export const GuppyEventSchema = Type.Intersect([
  Type.Union([ImmediateEventSchema, OneShotEventSchema, PeriodicEventSchema]),
  EventTargetSchema,
]);

export type ThreadTarget = Static<typeof ThreadTargetSchema>;
export type ChannelTarget = Static<typeof ChannelTargetSchema>;
export type EventTarget = Static<typeof EventTargetSchema>;
export type ImmediateEvent = Static<typeof ImmediateEventSchema>;
export type OneShotEvent = Static<typeof OneShotEventSchema>;
export type PeriodicEvent = Static<typeof PeriodicEventSchema>;
export type GuppyEvent = Static<typeof GuppyEventSchema>;

export type EventDispatch = (
  target: EventTarget,
  formattedText: string
) => void;
