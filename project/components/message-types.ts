import { AgentMessage } from "@guppy/core";
import { orpc } from "@/lib/rpc";

export type Messages = Awaited<ReturnType<typeof orpc.threads.messages.call>>;
export type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
export type ToolResultsMap = Map<string, ToolResultMessage>;

export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
export type AssistantContentBlock = AssistantMessage["content"][number];
export type UserMessage = Extract<AgentMessage, { role: "user" }>;
export type UserContentBlock = Extract<
  Exclude<UserMessage["content"], string>,
  unknown[]
>[number];

export type TextBlock = Extract<AssistantContentBlock, { type: "text" }>;
export type ThinkingBlock = Extract<AssistantContentBlock, { type: "thinking" }>;
export type ToolCallBlock = Extract<AssistantContentBlock, { type: "toolCall" }>;
export type ImageBlock = Extract<UserContentBlock, { type: "image" }>;
