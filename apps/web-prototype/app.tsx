import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Layout } from "./components/Layout.tsx";
import { HomePage } from "./components/HomePage.tsx";

// Simple client-side router
function useRoute() {
  const [path, setPath] = useState(window.location.hash.slice(1) || "/");

  React.useEffect(() => {
    const handler = () => setPath(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return path;
}

function App() {
  const path = useRoute();

  return (
    <Layout>
      <nav className="flex gap-4 mb-6 text-sm">
        <a href="#/" className="text-blue-400 hover:text-blue-300">Home</a>
        <a href="#/about" className="text-blue-400 hover:text-blue-300">About</a>
        <a href="#/projects/demo" className="text-blue-400 hover:text-blue-300">Project: demo</a>
        <span className="text-zinc-600">|</span>
        <a href="/ssr/" className="text-emerald-400 hover:text-emerald-300">SSR Home</a>
        <a href="/ssr/about" className="text-emerald-400 hover:text-emerald-300">SSR About</a>
      </nav>

      {path === "/" && <HomePage />}
      {path === "/about" && <AboutPage />}
      {path.startsWith("/projects/") && <ProjectPage slug={path.split("/")[2] ?? ""} />}
    </Layout>
  );
}

function AboutPage() {
  return (
    <div>
      <h2 className="text-2xl font-bold text-zinc-100">About</h2>
      <p className="text-zinc-400 mt-2">SPA about page. No server round-trip.</p>
    </div>
  );
}

function ProjectPage({ slug }: { slug: string }) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-zinc-100">Project: {slug}</h2>
      <p className="text-zinc-400 mt-2">Dynamic SPA route for project "{slug}".</p>
    </div>
  );
}

declare global {
  var __root: ReturnType<typeof createRoot> | undefined;
}

const root = globalThis.__root ??= createRoot(document.getElementById("root")!);
root.render(<App />);
