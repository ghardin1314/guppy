import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Link } from "react-router";
import { createRoot } from "react-dom/client";
import { queryClient } from "./lib/rpc";
import { routes } from "./.guppy/routes.gen";

function NotFound() {
  return (
    <div className="max-w-xl mx-auto p-10">
      <h1 className="text-2xl font-bold text-zinc-100">404</h1>
      <p className="text-zinc-400 mt-2">Page not found</p>
      <Link to="/" className="text-blue-400 hover:text-blue-300 text-sm mt-4 inline-block">
        &larr; Home
      </Link>
    </div>
  );
}

const router = createBrowserRouter([
  ...routes,
  { path: "*", Component: NotFound },
]);

const root = (import.meta.hot!.data.root ??= createRoot(document.getElementById("root")!));
root.render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
