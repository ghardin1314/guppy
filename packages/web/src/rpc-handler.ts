import { type Guppy, createThreadStoreAdapter } from "@guppy/core";
import type { SseTransportAdapter } from "@guppy/transport-sse";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import type { Router } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { GuppyContext } from "./rpc.ts";

/**
 * Creates fetch-compatible handlers for RPC and OpenAPI from one router.
 *
 * - `/rpc/*`  — typed client via RPCLink
 * - `/api/*`  — REST/webhook via OpenAPI
 */
export function createRpcHandlers(
  router: Router<any, GuppyContext>,
  guppy: Guppy,
  sse: SseTransportAdapter,
) {
  const rpcHandler = new RPCHandler(router);
  const apiHandler = new OpenAPIHandler(router);
  const store = createThreadStoreAdapter(guppy);

  async function handle(
    handler: RPCHandler<GuppyContext> | OpenAPIHandler<GuppyContext>,
    prefix: `/${string}`,
    req: Request,
  ): Promise<Response> {
    const { matched, response } = await handler.handle(req, {
      prefix,
      context: { guppy, sse, store, headers: req.headers },
    });
    if (matched) return response;
    return new Response("Not found", { status: 404 });
  }

  return {
    handleRpc: (req: Request) => handle(rpcHandler, "/rpc", req),
    handleApi: (req: Request) => handle(apiHandler, "/api", req),
  };
}
