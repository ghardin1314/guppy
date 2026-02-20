import { useState, useEffect, useRef, useCallback } from "react";
import type { ServerMessage } from "@guppy/transport-ws";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

// -- Types --------------------------------------------------------------------

interface Thread {
  id: string;
  title: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ToolExecution {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error";
  args?: unknown;
  result?: string;
}

/** Extract text content from an AgentMessage */
function extractText(msg: AgentMessage): string {
  if (!msg.content) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// -- WebSocket hook -----------------------------------------------------------

function useGuppySocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [channelId, setChannelId] = useState<string | null>(null);
  const handlersRef = useRef<((msg: ServerMessage) => void)[]>([]);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setChannelId(null);
    };
    ws.onmessage = (e) => {
      const msg: ServerMessage = JSON.parse(e.data);
      if (msg.type === "connected") setChannelId(msg.channelId);
      for (const handler of handlersRef.current) handler(msg);
    };

    return () => ws.close();
  }, []);

  const send = useCallback((data: object) => {
    wsRef.current?.send(JSON.stringify(data));
  }, []);

  const onMessage = useCallback((handler: (msg: ServerMessage) => void) => {
    handlersRef.current.push(handler);
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler);
    };
  }, []);

  return { connected, channelId, send, onMessage };
}

// -- Chat page ----------------------------------------------------------------

export default function ChatPage() {
  const { connected, send, onMessage } = useGuppySocket();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [tools, setTools] = useState<Map<string, ToolExecution>>(new Map());
  const [streaming, setStreaming] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, tools, streaming]);

  // Handle incoming agent events
  useEffect(() => {
    return onMessage((msg) => {
      if (msg.type !== "agent_event") return;
      const { threadId, event } = msg;
      handleAgentEvent(threadId, event as AgentEvent);
    });
  }, [onMessage]);

  function handleAgentEvent(threadId: string, event: AgentEvent) {
    switch (event.type) {
      case "agent_start":
        setStreaming(true);
        break;

      case "agent_end":
        setStreaming(false);
        break;

      case "message_start":
        if (event.message.role === "assistant") {
          appendOrUpdateAssistant(threadId, "");
        }
        break;

      case "message_update":
        if (event.message.role === "assistant") {
          appendOrUpdateAssistant(threadId, extractText(event.message));
        }
        break;

      case "message_end":
        if (event.message.role === "assistant") {
          appendOrUpdateAssistant(threadId, extractText(event.message));
        }
        break;

      case "tool_execution_start":
        setTools((prev) => {
          const next = new Map(prev);
          next.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "running",
            args: event.args,
          });
          return next;
        });
        break;

      case "tool_execution_end":
        setTools((prev) => {
          const next = new Map(prev);
          next.set(event.toolCallId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: event.isError ? "error" : "done",
            result: typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result),
          });
          return next;
        });
        break;
    }
  }

  function appendOrUpdateAssistant(threadId: string, text: string) {
    setMessages((prev) => {
      const next = new Map(prev);
      const threadMsgs = [...(next.get(threadId) ?? [])];
      const last = threadMsgs[threadMsgs.length - 1];
      if (last?.role === "assistant") {
        threadMsgs[threadMsgs.length - 1] = { ...last, content: text };
      } else {
        threadMsgs.push({ role: "assistant", content: text });
      }
      next.set(threadId, threadMsgs);
      return next;
    });
  }

  function createThread() {
    const id = crypto.randomUUID();
    const thread: Thread = {
      id,
      title: `Thread ${threads.length + 1}`,
    };
    setThreads((prev) => [...prev, thread]);
    setActiveThreadId(id);
    send({ type: "subscribe", threadId: id });
  }

  function switchThread(threadId: string) {
    // Unsubscribe from old
    if (activeThreadId) {
      send({ type: "unsubscribe", threadId: activeThreadId });
    }
    setActiveThreadId(threadId);
    send({ type: "subscribe", threadId });
  }

  function sendMessage() {
    if (!input.trim() || !activeThreadId) return;
    const content = input.trim();
    setInput("");

    // Add user message to local state
    setMessages((prev) => {
      const next = new Map(prev);
      const threadMsgs = [...(next.get(activeThreadId) ?? [])];
      threadMsgs.push({ role: "user", content });
      next.set(activeThreadId, threadMsgs);
      return next;
    });

    // Clear tool state for new prompt
    setTools(new Map());

    send({ type: "prompt", threadId: activeThreadId, content });
    inputRef.current?.focus();
  }

  function handleStop() {
    if (activeThreadId) {
      send({ type: "stop", threadId: activeThreadId });
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const activeMessages = activeThreadId
    ? (messages.get(activeThreadId) ?? [])
    : [];

  const activeTools = [...tools.values()];

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <div className="w-64 border-r border-zinc-800 flex flex-col">
        <div className="p-4 border-b border-zinc-800">
          <button
            onClick={createThread}
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            New Thread
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {threads.map((thread) => (
            <button
              key={thread.id}
              onClick={() => switchThread(thread.id)}
              className={`w-full text-left px-4 py-3 text-sm border-b border-zinc-800/50 transition-colors ${
                thread.id === activeThreadId
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
              }`}
            >
              {thread.title}
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-zinc-800 text-xs text-zinc-500">
          {connected ? (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Connected
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              Disconnected
            </span>
          )}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col">
        {activeThreadId ? (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {activeMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-blue-600 text-white"
                        : "bg-zinc-800 text-zinc-200"
                    }`}
                  >
                    <pre className="whitespace-pre-wrap font-[inherit]">{msg.content}</pre>
                  </div>
                </div>
              ))}

              {/* Tool executions */}
              {activeTools.length > 0 && (
                <div className="space-y-2">
                  {activeTools.map((tool) => (
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

              {streaming && (
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
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-500">
            Create or select a thread to start chatting
          </div>
        )}
      </div>
    </div>
  );
}
