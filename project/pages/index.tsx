import { Link } from "react-router";

export default function Home() {
  return (
    <div className="max-w-xl mx-auto p-10">
      <h1 className="text-3xl font-bold text-zinc-100">Guppy</h1>
      <p className="text-zinc-400 mt-3">Agent chat demo with WebSocket transport.</p>
      <Link
        to="/chat"
        className="inline-block mt-6 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
      >
        Open Chat
      </Link>
    </div>
  );
}
