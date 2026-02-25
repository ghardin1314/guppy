import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import type { Thread } from "chat";

const HistoryParams = Type.Object({
  limit: Type.Optional(
    Type.Number({ description: "Number of recent messages to fetch (default 20, max 100)" }),
  ),
});

type HistoryParams = Static<typeof HistoryParams>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Fetches recent thread messages. For deeper history search, the agent can
 * grep log.jsonl files directly via the bash tool.
 *
 * Future: we may sync full message history to log.jsonl before invoking
 * the agent, enabling fast local grep over complete history.
 */
export function createHistoryTool(thread: Thread): AgentTool<typeof HistoryParams, undefined> {
  return {
    name: "get_history",
    label: "Get History",
    description:
      "Fetch recent messages from this thread, newest first. " +
      "For searching older history, use bash to grep the thread's log.jsonl file.",
    parameters: HistoryParams,

    async execute(
      _toolCallId: string,
      params: HistoryParams,
      _signal?: AbortSignal,
      _onUpdate?: AgentToolUpdateCallback<undefined>,
    ): Promise<AgentToolResult<undefined>> {
      const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const messages: string[] = [];

      // thread.allMessages yields chronological (oldest first)
      // thread.channel.messages yields newest first — but that's channel-level
      // thread itself extends Postable which has .messages (newest first)
      for await (const msg of thread.messages) {
        if (messages.length >= limit) break;

        const date = msg.metadata.dateSent.toISOString();
        const author = msg.author.fullName || msg.author.userName;
        const label = msg.author.isBot ? `${author} [bot]` : author;
        const text =
          msg.text.length > 500 ? msg.text.slice(0, 500) + "..." : msg.text;
        messages.push(`[${date}] ${label}: ${text}`);
      }

      // Reverse so output reads chronologically (oldest → newest)
      messages.reverse();

      const output =
        messages.length > 0
          ? `${messages.length} recent message(s):\n\n${messages.join("\n\n")}`
          : "No messages in this thread.";

      const content: TextContent[] = [{ type: "text", text: output }];
      return { content, details: undefined };
    },
  };
}
