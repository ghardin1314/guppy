import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@guppy/web";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import type { Router } from "../procedures/index.ts";

const link = new RPCLink({
  url: new URL("/rpc", window.location.origin).href,
});

export const client: RouterClient<Router> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
    },
  },
});
