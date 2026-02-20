import type { Guppy, ThreadStoreAdapter } from "@guppy/core";
import type { SseTransportAdapter } from "@guppy/transport-sse";

export interface GuppyContext {
  guppy: Guppy;
  sse: SseTransportAdapter;
  store: ThreadStoreAdapter;
  headers: Headers;
}
