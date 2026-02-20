import { useRef, useState } from "react";
import { client } from "@/lib/rpc";

export function ChatInput({
  threadId,
  streaming,
}: {
  threadId: string;
  streaming: boolean;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function sendMessage() {
    if (!input.trim()) return;
    const content = input.trim();
    setInput("");
    await client.threads.prompt({ threadId, content });
    inputRef.current?.focus();
  }

  async function handleStop() {
    await client.threads.stop({ threadId });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
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
  );
}
