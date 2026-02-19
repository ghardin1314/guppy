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
