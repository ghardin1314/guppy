export default function About() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold text-emerald-400 mb-4">About Guppy</h1>
      <p className="text-zinc-400 mb-4">
        File-based routing. Drop a TSX file in <code className="text-zinc-300">pages/</code> — it becomes a route.
      </p>
      <a href="/" className="text-emerald-400 hover:text-emerald-300 text-sm mt-4 inline-block">
        &larr; Back home
      </a>
    </div>
  );
}
