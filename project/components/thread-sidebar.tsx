import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { orpc } from "../lib/rpc";

interface ThreadSidebarProps {
  activeThreadId?: string;
  connected?: boolean;
}

export function ThreadSidebar({ activeThreadId, connected }: ThreadSidebarProps) {
  const navigate = useNavigate();
  const { data: threads = [] } = useQuery(orpc.threads.list.queryOptions({ input: {} }));

  function createThread() {
    navigate("/threads/" + crypto.randomUUID());
  }

  return (
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
            key={thread.threadId}
            onClick={() => navigate("/threads/" + thread.threadId)}
            className={`w-full text-left px-4 py-3 text-sm border-b border-zinc-800/50 transition-colors ${
              thread.threadId === activeThreadId
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
            }`}
          >
            Thread {thread.threadId.slice(0, 8)}
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
  );
}
