/**
 * Core domain types for guppy.
 */

// -- Threads ------------------------------------------------------------------

export type ThreadStatus = "idle" | "active";

export interface Thread {
  readonly id: string;
  readonly transport: string;
  readonly channelId: string;
  readonly status: ThreadStatus;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly leafId: string | null;
  readonly metadata: string;
}

// -- Messages -----------------------------------------------------------------

export type MessageRole = "user" | "assistant" | "tool_result" | "summary";

export interface Message {
  readonly id: string;
  readonly threadId: string;
  readonly parentId: string | null;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: number;
}

// -- Events -------------------------------------------------------------------

export type EventType = "immediate" | "scheduled" | "cron";
export type EventStatus = "pending" | "delivered" | "canceled" | "failed";

export interface GuppyEvent {
  readonly id: string;
  readonly type: EventType;
  readonly targetThreadId: string;
  readonly sourceThreadId: string | null;
  readonly payload: string;
  readonly status: EventStatus;
  readonly scheduledAt: number | null;
  readonly cronExpression: string | null;
  readonly lastFiredAt: number | null;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}
