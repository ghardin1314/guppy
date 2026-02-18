import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { routes } from "./.guppy/routes.gen.ts";
import { matchRoute } from "../framework/router.ts";

function App() {
  const [pathname, setPathname] = useState(window.location.pathname);

  React.useEffect(() => {
    const handler = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const match = matchRoute(pathname, routes);

  if (!match) {
    return (
      <div className="max-w-xl mx-auto p-10">
        <h1 className="text-2xl font-bold text-zinc-100">404</h1>
        <p className="text-zinc-400 mt-2">Page not found: {pathname}</p>
        <a href="/" className="text-blue-400 hover:text-blue-300 text-sm mt-4 inline-block">
          &larr; Home
        </a>
      </div>
    );
  }

  const Page = match.component;
  return <Page params={match.params} />;
}

// Intercept <a> clicks for client-side navigation
document.addEventListener("click", (e) => {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("http") || href.startsWith("//") || href.startsWith("#")) return;
  if (anchor.hasAttribute("target")) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
});

// Use import.meta.hot.data for HMR-aware root (Bun's HMR API)
const root = (import.meta.hot!.data.root ??= createRoot(document.getElementById("root")!));
root.render(<App />);
