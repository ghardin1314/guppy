export default function Project({ params }: { params: Record<string, string> }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold text-zinc-100 mb-4">
        Project: {params.slug}
      </h1>
      <p className="text-zinc-400 mb-4">
        Dynamic route. The slug <code className="text-zinc-300">{params.slug}</code> was extracted from the URL.
      </p>
      <a href="/" className="text-emerald-400 hover:text-emerald-300 text-sm mt-4 inline-block">
        &larr; Back home
      </a>
    </div>
  );
}
