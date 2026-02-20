import { ChatInput } from "@/components/chat-input";
import { MessageList } from "@/components/message-list";
import type { Messages, ToolResultMessage } from "@/components/message-types";
import { ThreadSidebar } from "@/components/thread-sidebar";
import { orpc } from "@/lib/rpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useParams } from "react-router";

export default function ThreadPage() {
  const params = useParams<{ threadId: string }>();
  // TODO: Add guard
  const threadId = params.threadId!;
  const qc = useQueryClient();

  const [streaming, setStreaming] = useState(false);
  const messagesQueryKey = orpc.threads.messages.queryOptions({
    input: { threadId },
  }).queryKey;
  const {
    data: messages = [],
    isPending,
    error,
  } = useQuery(orpc.threads.messages.queryOptions({ input: { threadId } }));

  const toolResults = useMemo(() => {
    const resultMap = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.content.role === "toolResult") {
        resultMap.set(msg.content.toolCallId, msg.content);
      }
    }
    return resultMap;
  }, [messages]);

  const {} = useQuery({
    queryKey: orpc.threads.events.experimental_streamedOptions({
      input: { threadId },
    }).queryKey,
    retry: true,
    queryFn: async ({ signal }) => {
      const stream = await orpc.threads.events.call({ threadId });
      let currentMessageId: string | null = null;
      for await (const msg of stream) {
        if (signal.aborted) break;
        if (msg.type === "heartbeat") {
          continue;
        }
        if (msg.event.type === "agent_start") {
          setStreaming(true);
        } else if (msg.event.type === "agent_end") {
          setStreaming(false);
        } else if (msg.event.type === "message_start") {
          currentMessageId = `current-message-${Date.now()}`;
          const content = msg.event.message;
          qc.setQueryData(messagesQueryKey, (old: Messages = []) => [
            ...old,
            {
              id: currentMessageId!,
              threadId,
              parentId: null,
              content,
              createdAt: Date.now(),
            },
          ]);
        } else if (msg.event.type === "message_update") {
          const content = msg.event.message;
          qc.setQueryData(messagesQueryKey, (old: Messages = []) =>
            old.map((m) => (m.id === currentMessageId ? { ...m, content } : m)),
          );
        } else if (msg.event.type === "message_end") {
          currentMessageId = null;
        } else if (msg.event.type === "tool_execution_start") {
          const content = msg.event;
          qc.setQueryData(messagesQueryKey, (old: Messages = []) => [
            ...old,
            {
              id: content.toolCallId,
              threadId,
              parentId: null,
              content: {
                role: "toolResult" as const,
                toolCallId: content.toolCallId,
                toolName: content.toolName,
                content: [],
                isError: false,
                timestamp: Date.now(),
              },
              createdAt: Date.now(),
            },
          ]);
        } else if (msg.event.type === "tool_execution_update") {
          // TODO: handle streamed tool execution update
        } else if (msg.event.type === "tool_execution_end") {
          const content = msg.event;
          const newContent: Messages[number]["content"] = {
            role: "toolResult" as const,
            toolCallId: content.toolCallId,
            toolName: content.toolName,
            content: [],
            isError: content.isError,
            timestamp: Date.now(),
          };
          qc.setQueryData(messagesQueryKey, (old: Messages = []) =>
            old.map((m) =>
              m.id === content.toolCallId ? { ...m, content: newContent } : m,
            ),
          );
        } else if (msg.event.type === "turn_start") {
          currentMessageId = null;
        } else if (msg.event.type === "turn_end") {
          currentMessageId = null;
        }
      }
    },
  });

  if (isPending) return <div className="flex h-screen items-center justify-center">Loading thread...</div>;
  if (error) return <div className="flex h-screen items-center justify-center text-red-500">Error: {error.message}</div>;

  return (
    <div className="flex h-screen">
      <ThreadSidebar activeThreadId={threadId} connected={true} />
      <div className="flex-1 flex flex-col">
        <div className="bg-muted/50 p-2 text-center text-sm text-muted-foreground border-b">
          Thread ID: {threadId}
        </div>
        <MessageList messages={messages} toolResults={toolResults} />
        <ChatInput threadId={threadId} streaming={streaming} />
      </div>
    </div>
  );
}
