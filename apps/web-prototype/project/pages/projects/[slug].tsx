import { useParams, Link } from "react-router";

export default function Project() {
  const { slug } = useParams();
  return (
    <div className="max-w-3xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-bold text-zinc-100 mb-4">
        Project: {slug}
      </h1>
      <p className="text-zinc-400 mb-4">
        Dynamic route. The slug <code className="text-zinc-300">{slug}</code> was extracted from the URL.
      </p>
      <Link to="/" className="text-emerald-400 hover:text-emerald-300 text-sm mt-4 inline-block">
        &larr; Back home
      </Link>
    </div>
  );
}
