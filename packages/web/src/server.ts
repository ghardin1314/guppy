import type { Guppy } from "@guppy/core";
import type { WsTransportAdapter } from "@guppy/transport-ws";
import type { Router } from "@orpc/server";
import type { HTMLBundle } from "bun";
import { watch } from "fs/promises";
import { generateRoutes } from "./generate-routes.ts";
import { createRpcHandlers } from "./rpc-handler.ts";
import type { GuppyContext } from "./rpc.ts";

interface WsData {
  channelId: string;
}

export async function createServer(
  projectDir: string,
  shell: HTMLBundle,
  options: { guppy: Guppy; ws: WsTransportAdapter; router: Router<any, GuppyContext>; port?: number },
) {
  await generateRoutes(projectDir);

  const { guppy, ws, router } = options;
  const { handleRpc, handleApi } = createRpcHandlers(router, guppy);

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

  const port =
    options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);

  const server = Bun.serve<WsData>({
    port,

    routes: {
      "/rpc/*": handleRpc,
      "/api/*": handleApi,
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
  RPC:     http://localhost:${server.port}/rpc
  API:     http://localhost:${server.port}/api/health
  WS:      ws://localhost:${server.port}/ws
`);

  return server;
}
