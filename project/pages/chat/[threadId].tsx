import { useState, useEffect, useRef, useMemo } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentMessage } from "@guppy/core";
import { orpc, client } from "../../lib/rpc";
import { ThreadSidebar } from "../../components/thread-sidebar";

// -- Types --------------------------------------------------------------------

type EventPayload = Awaited<ReturnType<typeof client.threads.events>> extends AsyncIterable<infer T> ? T : never;

interface ToolExecution {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error";
  args?: unknown;
  result?: string;
}

// -- Helpers ------------------------------------------------------------------

function extractText(msg: AgentMessage): string {
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** Derive ephemeral live state from SSE events */
function deriveLiveState(events: EventPayload[]) {
  let currentAssistantText = "";
  let tools = new Map<string, ToolExecution>();
  let streaming = false;

  for (const { event } of events) {
    switch (event.type) {
      case "agent_start":
        streaming = true;
        tools = new Map();
        currentAssistantText = "";
        break;
      case "agent_end":
        streaming = false;
        currentAssistantText = "";
        tools = new Map();
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          currentAssistantText = "";
        }
        break;
      case "message_update":
      case "message_end":
        if (event.message.role === "assistant") {
          currentAssistantText = extractText(event.message);
        }
        break;
      case "tool_execution_start":
        tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "running",
          args: event.args,
        });
        break;
      case "tool_execution_end":
        tools.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: event.isError ? "error" : "done",
          result: typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result),
        });
        break;
    }
  }

  return { currentAssistantText, tools: [...tools.values()], streaming };
}

// -- Chat page ----------------------------------------------------------------

export default function ChatThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // DB messages — the single source of truth
  const messagesQueryKey = orpc.threads.messages.queryOptions({ input: { threadId: threadId! } }).queryKey;
  const { data: dbMessages = [] } = useQuery(
    orpc.threads.messages.queryOptions({ input: { threadId: threadId! } }),
  );

  // SSE event stream — ephemeral overlay
  const { data: events = [], fetchStatus } = useQuery({
    ...orpc.threads.events.experimental_streamedOptions({
      input: { threadId: threadId! },
      queryFnOptions: { refetchMode: "append" },
    }),
    retry: true,
    retryDelay: 2000,
  });

  const connected = fetchStatus === "fetching";
  const { currentAssistantText, tools, streaming } = useMemo(
    () => deriveLiveState(events),
    [events],
  );

  // On agent_end → refetch DB messages + thread list
  const eventsLen = events.length;
  useEffect(() => {
    if (eventsLen > 0 && events[eventsLen - 1]?.event.type === "agent_end") {
      qc.invalidateQueries({ queryKey: messagesQueryKey });
      qc.invalidateQueries({ queryKey: orpc.threads.list.queryOptions({ input: {} }).queryKey });
    }
  }, [eventsLen, qc, messagesQueryKey]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [dbMessages, currentAssistantText, tools, streaming]);

  async function sendMessage() {
    if (!input.trim() || !threadId) return;
    const content = input.trim();
    setInput("");

    // Optimistic append to TanStack Query cache
    qc.setQueryData(messagesQueryKey, (old: typeof dbMessages = []) => [
      ...old,
      {
        id: "optimistic-" + Date.now(),
        threadId,
        parentId: null,
        content: { role: "user" as const, content, timestamp: Date.now() },
        createdAt: Date.now(),
      },
    ]);

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

  return (
    <div className="flex h-screen">
      <ThreadSidebar activeThreadId={threadId} connected={connected} />

      <div className="flex-1 flex flex-col">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* DB messages (permanent) */}
          {dbMessages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.content.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.content.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-800 text-zinc-200"
                }`}
              >
                <pre className="whitespace-pre-wrap font-[inherit]">
                  {extractText(msg.content as AgentMessage)}
                </pre>
              </div>
            </div>
          ))}

          {/* Live overlay — ephemeral streaming content */}
          {currentAssistantText && (
            <div className="flex justify-start">
              <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed bg-zinc-800 text-zinc-200">
                <pre className="whitespace-pre-wrap font-[inherit]">
                  {currentAssistantText}
                </pre>
              </div>
            </div>
          )}

          {/* Tool executions */}
          {tools.length > 0 && (
            <div className="space-y-2">
              {tools.map((tool) => (
                <div
                  key={tool.toolCallId}
                  className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    {tool.status === "running" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    )}
                    {tool.status === "done" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    )}
                    {tool.status === "error" && (
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    )}
                    <span className="text-zinc-400 font-mono">{tool.toolName}</span>
                    {tool.args != null && (
                      <span className="text-zinc-600 truncate max-w-xs">
                        {typeof tool.args === "string"
                          ? tool.args
                          : JSON.stringify(tool.args)}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {streaming && !currentAssistantText && (
            <div className="flex items-center gap-2 text-zinc-500 text-sm">
              <div className="flex gap-1">
                <span className="w-1 h-1 rounded-full bg-zinc-500 animate-bounce [animation-delay:0ms]" />
                <span className="w-1 h-1 rounded-full bg-zinc-500 animate-bounce [animation-delay:150ms]" />
                <span className="w-1 h-1 rounded-full bg-zinc-500 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-zinc-800 p-4">
          <div className="flex gap-2">
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
