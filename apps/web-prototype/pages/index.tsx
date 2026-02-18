export default function Home() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
      <h1 className="text-3xl font-bold text-zinc-100 mb-4">SSR Home</h1>
      <p className="text-zinc-400 mb-4">
        This page is server-rendered via <code>renderToReadableStream</code>.
      </p>
      <nav className="flex gap-4 text-sm">
        <a href="/ssr/about" className="text-emerald-400 hover:text-emerald-300">About</a>
        <a href="/ssr/projects/demo" className="text-emerald-400 hover:text-emerald-300">Project: demo</a>
        <span className="text-zinc-600">|</span>
        <a href="/" className="text-blue-400 hover:text-blue-300">SPA</a>
      </nav>
    </div>
  );
}
