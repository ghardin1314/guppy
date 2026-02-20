import { ThreadSidebar } from "@/components/thread-sidebar";
import { client, orpc } from "@/lib/rpc";
import { AgentMessage } from "@guppy/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useParams } from "react-router";

type Messages = Awaited<ReturnType<typeof orpc.threads.messages.call>>;

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolResultsMap = Map<string, ToolResultMessage>;

export default function ThreadPage() {
  const params = useParams<{ threadId: string }>();
  // TODO: Add guard
  const threadId = params.threadId!;
  const qc = useQueryClient();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const messagesQueryKey = orpc.threads.messages.queryOptions({
    input: { threadId: threadId! },
  }).queryKey;
  const {
    data: messages = [],
    isPending,
    error,
  } = useQuery(
    orpc.threads.messages.queryOptions({ input: { threadId: threadId! } }),
  );

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
      input: { threadId: threadId! },
    }).queryKey,
    queryFn: async ({ signal }) => {
      const stream = await orpc.threads.events.call({ threadId: threadId! });
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
          const content = msg.event;
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
              m.id === content.toolCallId
                ? {
                    ...m,
                    content: newContent,
                  }
                : m,
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

  async function sendMessage() {
    if (!input.trim() || !threadId) return;
    const content = input.trim();
    setInput("");

    // Optimistic append
    // I guess we don't need this because the stream sends it back immediately
    // qc.setQueryData(messagesQueryKey, (old: Messages = []) => [
    //   ...old,
    //   {
    //     id: "optimistic-" + Date.now(),
    //     threadId,
    //     parentId: null,
    //     content: { role: "user" as const, content, timestamp: Date.now() },
    //     createdAt: Date.now(),
    //   },
    // ]);

    await client.threads.prompt({ threadId, content });
    inputRef.current?.focus();
  }

  async function handleStop() {
    await client.threads.stop({ threadId: threadId! });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  if (isPending) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div className="flex h-screen">
      <ThreadSidebar activeThreadId={threadId} connected={true} />
      <div className="flex-1 flex flex-col">
        <MessageList messages={messages} toolResults={toolResults} />
        <div className="border-t border-zinc-800 p-4">
          <div className="flex gap-3">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              rows={1}
              className="flex-1 bg-zinc-800 text-zinc-100 placeholder-zinc-500 rounded-lg px-4 py-2.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500/50"
            />
            {streaming ? (
              <button
                onClick={handleStop}
                className="px-4 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-medium transition-colors"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!input.trim()}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export const MessageList = ({
  messages,
  toolResults,
}: {
  messages: { content: AgentMessage; id: string }[];
  toolResults: ToolResultsMap;
}) => {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          toolResults={toolResults}
        />
      ))}
    </div>
  );
};

export const MessageItem = ({
  message,
  toolResults,
}: {
  message: { content: AgentMessage; id: string };
  toolResults: ToolResultsMap;
}) => {
  const { content } = message;
  switch (content.role) {
    case "assistant":
      return (
        <AssistantMessageItem message={content} toolResults={toolResults} />
      );
    case "user":
      return <UserMessageItem message={content} />;
    case "toolResult":
      // Tool results are rendered inline with the tool call
      return null;
  }
};

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

export const AssistantMessageItem = ({
  message,
  toolResults,
}: {
  message: AssistantMessage;
  toolResults: ToolResultsMap;
}) => {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] space-y-2">
        {message.content.map((content, i) => {
          if (content.type === "text") {
            return <TextContentItem key={i} content={content} />;
          } else if (content.type === "thinking") {
            return <ThinkingContentItem key={i} content={content} />;
          } else if (content.type === "toolCall") {
            return (
              <ToolCallItem
                key={i}
                content={content}
                toolResults={toolResults}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
};

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type UserContentBlock = Extract<
  Exclude<UserMessage["content"], string>,
  unknown[]
>[number];

export const UserMessageItem = ({ message }: { message: UserMessage }) => {
  if (typeof message.content === "string") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-blue-600 text-white whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-blue-600 text-white whitespace-pre-wrap space-y-2">
        {message.content.map((content, i) => {
          if (content.type === "text") {
            return <span key={i}>{content.text}</span>;
          } else if (content.type === "image") {
            return <ImageContentItem key={i} content={content} />;
          }
          return null;
        })}
      </div>
    </div>
  );
};

export const ToolResultMessageItem = ({
  message,
}: {
  message: ToolResultMessage;
}) => {
  const text = message.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
  const isRunning = message.content.length === 0;

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%]">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            ) : message.isError ? (
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            )}
            <span className="text-zinc-400 font-mono">{message.toolName}</span>
          </div>
          {text && (
            <pre className="whitespace-pre-wrap font-mono text-zinc-500 max-h-32 overflow-y-auto mt-1">
              {text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
};

// -- Content block components -------------------------------------------------

type TextBlock = Extract<AssistantContentBlock, { type: "text" }>;
type ThinkingBlock = Extract<AssistantContentBlock, { type: "thinking" }>;
type ToolCallBlock = Extract<AssistantContentBlock, { type: "toolCall" }>;
type ImageBlock = Extract<UserContentBlock, { type: "image" }>;

const TextContentItem = ({ content }: { content: TextBlock }) => (
  <div className="rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-zinc-800 text-zinc-200">
    <pre className="whitespace-pre-wrap font-[inherit]">{content.text}</pre>
  </div>
);

const ThinkingContentItem = ({ content }: { content: ThinkingBlock }) => (
  <details className="rounded-xl bg-zinc-900 border border-zinc-800 text-xs">
    <summary className="px-4 py-2 text-zinc-500 cursor-pointer select-none">
      Thinking...
    </summary>
    <pre className="whitespace-pre-wrap font-mono text-zinc-600 px-4 pb-2 max-h-48 overflow-y-auto">
      {content.thinking}
    </pre>
  </details>
);

const ToolCallItem = ({
  content,
  toolResults,
}: {
  content: ToolCallBlock;
  toolResults: ToolResultsMap;
}) => {
  const result = toolResults.get(content.id);
  const isError = result?.isError;
  const isPending = !isError && result?.content.length === 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {isPending ? (
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
        ) : isError ? (
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        )}
        <span className="text-zinc-400 font-mono">{content.name}</span>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-zinc-600 max-h-20 overflow-y-auto mt-1">
        {JSON.stringify(content.arguments, null, 2)}
      </pre>
      {result && (
        <pre className="whitespace-pre-wrap font-mono text-zinc-500 max-h-32 overflow-y-auto mt-1">
          {result.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")}
        </pre>
        // TODO: handle image content
      )}
    </div>
  );
};

const ImageContentItem = ({ content }: { content: ImageBlock }) => (
  <img
    src={`data:${content.mimeType};base64,${content.data}`}
    className="max-w-full rounded-lg"
  />
);
