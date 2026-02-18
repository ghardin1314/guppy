import { useState, useEffect } from "react";

export default function Status() {
  const [health, setHealth] = useState<{ status: string; uptime: number } | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth);
  }, []);

  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold text-zinc-100 mb-6">System Status</h1>
      {health ? (
        <div className="rounded-lg border border-zinc-800 p-6 space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-emerald-500" />
            <span className="text-zinc-200 font-medium">{health.status}</span>
          </div>
          <p className="text-zinc-400">
            Uptime: {Math.floor(health.uptime)}s
          </p>
        </div>
      ) : (
        <p className="text-zinc-500">Loading...</p>
      )}
      <a href="/" className="text-emerald-400 hover:text-emerald-300 text-sm mt-6 inline-block">
        &larr; Back home
      </a>
    </div>
  );
}
