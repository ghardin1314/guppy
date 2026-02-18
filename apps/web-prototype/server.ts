import { renderToReadableStream } from "react-dom/server";
import { createElement } from "react";
import { watch } from "fs/promises";
import shell from "./shell.html";

const BASE = import.meta.dir;
const SSR_CSS_PATH = `${BASE}/styles/ssr-output.css`;

// --- Tailwind CLI: build SSR styles ---
const tailwindArgs = ["-i", `${BASE}/styles/global.css`, "-o", SSR_CSS_PATH];
async function buildSSRStyles() {
  await Bun.$`bunx @tailwindcss/cli ${tailwindArgs}`.quiet();
  console.log("[tailwind] SSR styles rebuilt");
}
await buildSSRStyles();

// --- FileSystemRouters ---
const pageRouter = new Bun.FileSystemRouter({
  style: "nextjs",
  dir: `${BASE}/pages`,
});

const apiRouter = new Bun.FileSystemRouter({
  style: "nextjs",
  dir: `${BASE}/routes`,
});

// --- WebSocket state ---
const clients = new Set<import("bun").ServerWebSocket<unknown>>();

// --- File watchers: reload routers on changes ---
async function watchDir(dir: string, router: InstanceType<typeof Bun.FileSystemRouter>, rebuildCSS = false) {
  for await (const event of watch(dir, { recursive: true })) {
    console.log(`[watch] ${dir} changed: ${event.eventType} ${event.filename ?? ""}`);
    router.reload();
    if (rebuildCSS) await buildSSRStyles();
  }
}
watchDir(`${BASE}/pages`, pageRouter, true);
watchDir(`${BASE}/routes`, apiRouter);

// --- Route handlers ---

async function handleAPI(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const apiPath = url.pathname.replace(/^\/api/, "");
  const match = apiRouter.match(apiPath);
  if (!match) return new Response("Not found", { status: 404 });

  const mod = await import(match.filePath);
  const handler = mod[req.method] ?? mod.default;
  if (!handler) return new Response("Method not allowed", { status: 405 });
  return handler(req, { params: match.params, query: match.query });
}

async function handleSSR(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const ssrPath = url.pathname.replace(/^\/ssr/, "") || "/";
  const match = pageRouter.match(ssrPath);
  if (!match) return new Response("Not found", { status: 404 });

  const mod = await import(match.filePath);
  const Component = mod.default;
  const stream = await renderToReadableStream(
    createElement(
      "html",
      null,
      createElement(
        "head",
        null,
        createElement("meta", { charSet: "utf-8" }),
        createElement("meta", {
          name: "viewport",
          content: "width=device-width, initial-scale=1",
        }),
        createElement("link", {
          rel: "stylesheet",
          href: "/ssr/styles.css",
        })
      ),
      createElement(
        "body",
        null,
        createElement(Component, { params: match.params, query: match.query })
      )
    )
  );
  return new Response(stream, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// --- Server ---
const server = Bun.serve({
  port: 3456,

  routes: {
    "/": shell,

    "/ssr/styles.css": () => new Response(Bun.file(SSR_CSS_PATH)),
    "/ssr/*": handleSSR,

    "/api/_reload": () => {
      pageRouter.reload();
      apiRouter.reload();
      return Response.json({ ok: true, message: "routers reloaded" });
    },
    "/api/_routes": () => {
      return Response.json({
        pages: Object.keys(pageRouter.routes),
        api: Object.keys(apiRouter.routes),
      });
    },
    "/api/_broadcast": async (req) => {
      const body = await req.json() as { message: string };
      for (const ws of clients) {
        ws.send(JSON.stringify({ type: "broadcast", data: body.message }));
      }
      return Response.json({ ok: true, sent: clients.size });
    },
    "/api/*": handleAPI,
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "connected", clients: clients.size }));
      console.log(`[ws] client connected (${clients.size} total)`);
    },
    message(ws, message) {
      ws.send(JSON.stringify({ type: "echo", data: String(message) }));
    },
    close(ws) {
      clients.delete(ws);
      console.log(`[ws] client disconnected (${clients.size} total)`);
    },
  },

  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return new Response("Not found", { status: 404 });
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`
🐟 Web prototype running at http://localhost:${server.port}

  SPA:  http://localhost:${server.port}/
  SSR:  http://localhost:${server.port}/ssr/
  SSR:  http://localhost:${server.port}/ssr/about
  SSR:  http://localhost:${server.port}/ssr/projects/my-project
  API:  http://localhost:${server.port}/api/health
  WS:   ws://localhost:${server.port}/ws
`);
