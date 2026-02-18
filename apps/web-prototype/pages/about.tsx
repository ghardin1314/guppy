export default function About() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
      <h1 className="text-3xl font-bold text-zinc-100 mb-4">About</h1>
      <p className="text-zinc-400 mb-4">
        SSR about page. Dropped as a TSX file in <code>pages/</code> — no HTML file needed.
      </p>
      <p className="text-zinc-500 text-sm">
        Rendered at {new Date().toISOString()}
      </p>
      <a href="/ssr/" className="text-emerald-400 hover:text-emerald-300 text-sm mt-4 inline-block">
        &larr; Back to SSR home
      </a>
    </div>
  );
}
