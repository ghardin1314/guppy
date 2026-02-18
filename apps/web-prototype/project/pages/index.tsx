import { Link } from "react-router";
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
        <Link to="/" className="text-blue-400 hover:text-blue-300">Home</Link>
        <Link to="/about" className="text-blue-400 hover:text-blue-300">About</Link>
        <Link to="/projects/demo" className="text-blue-400 hover:text-blue-300">Project: demo</Link>
        <Link to="/status" className="text-yellow-400 hover:text-yellow-300">Status</Link>
      </nav>
      <div className="grid grid-cols-2 gap-6">
        <Counter />
        <WsStatus />
      </div>
    </div>
  );
}
