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
  // Bun's built-in HMR handles pushing client updates for existing pages.
  // Debounce collapses rapid FS events during file rewrites into one call.
  async function watchPages() {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    for await (const event of watch(`${projectDir}/pages`, {
      recursive: true,
    })) {
      if (event.filename?.includes(".tmp.")) continue;
      console.log(
        `[watch] pages changed: ${event.eventType} ${event.filename ?? ""}`,
      );
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        generateRoutes(projectDir);
      }, 200);
    }
  }
  watchPages();

  const port =
    options.port ?? (process.env.PORT ? Number(process.env.PORT) : 3456);

  const server = Bun.serve({
    port,
    idleTimeout: 5, // short for testing — SSE heartbeat keeps connections alive

    routes: {
      "/rpc/*": handleRpc,
      "/api/*": handleApi,

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
`);

  return server;
}
