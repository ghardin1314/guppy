import type { Guppy } from "@guppy/core";
import type { WsTransportAdapter } from "@guppy/transport-ws";
import type { HTMLBundle } from "bun";
import { watch } from "fs/promises";
import { generateRoutes } from "./generate-routes.ts";

export interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string>;
  guppy: Guppy;
}

interface WsData {
  channelId: string;
}

export async function createServer(
  projectDir: string,
  shell: HTMLBundle,
  options: { guppy: Guppy; ws: WsTransportAdapter; port?: number },
) {
  await generateRoutes(projectDir);

  const apiRouter = new Bun.FileSystemRouter({
    style: "nextjs",
    dir: `${projectDir}/routes`,
  });

  const { guppy, ws } = options;

  // Watch pages/ → regenerate route manifest (new routes only)
  // Bun's built-in HMR handles pushing client updates for existing pages
  async function watchPages() {
    for await (const event of watch(`${projectDir}/pages`, {
      recursive: true,
    })) {
      if (event.filename?.includes(".tmp.")) continue;
      console.log(
        `[watch] pages changed: ${event.eventType} ${event.filename ?? ""}`,
      );
      await generateRoutes(projectDir);
    }
  }
  watchPages();

  // Watch routes/ → reload API router
  async function watchRoutes() {
    for await (const event of watch(`${projectDir}/routes`, {
      recursive: true,
    })) {
      console.log(
        `[watch] routes changed: ${event.eventType} ${event.filename ?? ""}`,
      );
      apiRouter.reload();
    }
  }
  watchRoutes();

  async function handleAPI(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const apiPath = url.pathname.replace(/^\/api/, "");
    const match = apiRouter.match(apiPath);
    if (!match) return new Response("Not found", { status: 404 });

    const mod = await import(match.filePath);
    const handler = mod[req.method] ?? mod.default;
    if (!handler) return new Response("Method not allowed", { status: 405 });
    return handler(req, {
      params: match.params,
      query: match.query,
      guppy,
    } satisfies RouteContext);
  }

  const port =
    options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);

  const server = Bun.serve<WsData>({
    port,

    routes: {
      "/api/*": handleAPI,
      "/*": shell,
    },

    websocket: {
      async open(socket) {
        const { channelId } = socket.data;
        await ws.connect(channelId, socket);
        console.log(`[ws] channel ${channelId} connected`);
      },

      async message(socket, raw) {
        await ws.handleMessage(socket.data.channelId, String(raw));
      },

      async close(socket) {
        const { channelId } = socket.data;
        await ws.disconnect(channelId);
        console.log(`[ws] channel ${channelId} disconnected`);
      },
    },

    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const channelId = crypto.randomUUID();
        if (server.upgrade(req, { data: { channelId } }))
          return undefined as unknown as Response;
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
🐟 Guppy web server running at http://localhost:${server.port}

  Project: ${projectDir}
  Pages:   http://localhost:${server.port}/
  API:     http://localhost:${server.port}/api/health
  WS:      ws://localhost:${server.port}/ws
`);

  return server;
}
