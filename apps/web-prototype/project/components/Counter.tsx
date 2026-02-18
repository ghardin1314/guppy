import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div className="rounded-lg border border-zinc-800 p-4 space-y-3">
      <h3 className="text-sm font-medium text-zinc-400">Counter (HMR test)</h3>
      <p className="text-4xl font-bold text-zinc-100">{count}</p>
      <div className="flex gap-2">
        <button
          onClick={() => setCount((c) => c + 1)}
          className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-sm text-white"
        >
          +1
        </button>
        <button
          onClick={() => setCount(0)}
          className="px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-sm text-white"
        >
          Reset
        </button>
      </div>
      <p className="text-xs text-zinc-600">Increment, then edit this file. If HMR works, count survives.</p>
    </div>
  );
}
