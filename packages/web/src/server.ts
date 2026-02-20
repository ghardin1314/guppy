import type { Guppy } from "@guppy/core";
import type { SseTransportAdapter } from "@guppy/transport-sse";
import type { Router } from "@orpc/server";
import type { HTMLBundle } from "bun";
import { watch } from "fs/promises";
import { generateRoutes } from "./generate-routes.ts";
import { createRpcHandlers } from "./rpc-handler.ts";
import type { GuppyContext } from "./rpc.ts";

export async function createServer(
  projectDir: string,
  shell: HTMLBundle,
  options: { guppy: Guppy; sse: SseTransportAdapter; router: Router<any, GuppyContext>; port?: number },
) {
  await generateRoutes(projectDir);

  const { guppy, sse, router } = options;
  const { handleRpc, handleApi } = createRpcHandlers(router, guppy, sse);

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

  const server = Bun.serve({
    port,
    idleTimeout: 255, // max value — keeps SSE streams alive

    routes: {
      "/rpc/*": handleRpc,
      "/api/*": handleApi,

      "/events/:threadId": (req) => {
        const threadId = req.params.threadId;
        let sendFn: ((data: string) => void) | null = null;

        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            sendFn = (data: string) => {
              controller.enqueue(
                encoder.encode(`event: agent_event\ndata: ${data}\n\n`),
              );
            };
            sse.addListener(threadId, sendFn);

            // Send initial connected event
            controller.enqueue(
              encoder.encode(`event: connected\ndata: {}\n\n`),
            );
          },
          cancel() {
            if (sendFn) {
              sse.removeListener(threadId, sendFn);
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },

      "/*": shell,
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
  SSE:     http://localhost:${server.port}/events/:threadId
`);

  return server;
}
