import { Counter } from "./Counter.tsx";
import { WsStatus } from "./WsStatus.tsx";

export function HomePage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-zinc-100">SPA Home</h2>
      <p className="text-zinc-400">This is the SPA entry point served from shell.html with client-side hash routing.</p>
      <div className="grid grid-cols-2 gap-6">
        <Counter />
        <WsStatus />
      </div>
    </div>
  );
}
