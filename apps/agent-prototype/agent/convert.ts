import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { MessageRow } from "../db/messages.ts";

/**
 * Convert SQLite message rows → AgentMessage[] for the agent loop.
 * Content is stored as JSON, so we parse it back.
 */
export function rowsToAgentMessages(rows: MessageRow[]): AgentMessage[] {
  return rows.map((row) => {
    const content = JSON.parse(row.content);
    switch (row.role) {
      case "user":
        return { role: "user" as const, content, timestamp: row.created_at };
      case "assistant":
        return content; // AssistantMessage is stored whole (includes usage, model, etc.)
      case "toolResult":
        return content; // ToolResultMessage is stored whole
      case "summary":
        // Summaries are treated as user messages for context
        return { role: "user" as const, content, timestamp: row.created_at };
      default:
        return { role: "user" as const, content: String(content), timestamp: row.created_at };
    }
  });
}

/**
 * Convert AgentMessage → { role, content } for SQLite storage.
 * For assistant and toolResult, store the entire message object.
 * For user, just store the content.
 */
export function agentMessageToRow(msg: AgentMessage): { role: string; content: unknown } {
  const m = msg as Message;
  switch (m.role) {
    case "user":
      return { role: "user", content: m.content };
    case "assistant":
      return { role: "assistant", content: m }; // store entire AssistantMessage
    case "toolResult":
      return { role: "toolResult", content: m }; // store entire ToolResultMessage
    default:
      return { role: "unknown", content: m };
  }
}

/**
 * Default convertToLlm — keep only LLM-compatible messages.
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return (messages as Message[]).filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
  );
}
