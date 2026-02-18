import { useState, useEffect, useRef } from "react";

export function WsStatus() {
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [messages, setMessages] = useState<string[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setStatus("open");
    ws.onclose = () => setStatus("closed");
    ws.onmessage = (e) => {
      setMessages((prev) => [...prev.slice(-9), e.data]);
    };

    return () => ws.close();
  }, []);

  const send = () => {
    wsRef.current?.send("ping " + Date.now());
  };

  return (
    <div className="rounded-lg border border-zinc-800 p-4 space-y-3">
      <h3 className="text-sm font-medium text-zinc-400">WebSocket</h3>
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${
            status === "open" ? "bg-emerald-500" : status === "connecting" ? "bg-yellow-500" : "bg-red-500"
          }`}
        />
        <span className="text-sm text-zinc-300">{status}</span>
      </div>
      <button
        onClick={send}
        disabled={status !== "open"}
        className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-sm text-white"
      >
        Send ping
      </button>
      <div className="text-xs text-zinc-500 space-y-0.5 max-h-32 overflow-auto">
        {messages.map((m, i) => (
          <div key={i} className="font-mono">{m}</div>
        ))}
      </div>
    </div>
  );
}
