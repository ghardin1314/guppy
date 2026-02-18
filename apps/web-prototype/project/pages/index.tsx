import { Counter } from "../components/Counter.tsx";
import { WsStatus } from "../components/WsStatus.tsx";

export default function Home() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-zinc-100">
          guppy <span className="text-zinc-500 font-normal text-lg">web prototype</span>
        </h1>
      </header>
      <nav className="flex gap-4 mb-6 text-sm">
        <a href="/" className="text-blue-400 hover:text-blue-300">Home</a>
        <a href="/about" className="text-blue-400 hover:text-blue-300">About</a>
        <a href="/projects/demo" className="text-blue-400 hover:text-blue-300">Project: demo</a>
        <a href="/status" className="text-yellow-400 hover:text-yellow-300">Status</a>
      </nav>
      <div className="grid grid-cols-2 gap-6">
        <Counter />
        <WsStatus />
      </div>
    </div>
  );
}
