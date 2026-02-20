import type { Guppy } from "@guppy/core";
import type { SseTransportAdapter } from "@guppy/transport-sse";

export interface GuppyContext {
  guppy: Guppy;
  sse: SseTransportAdapter;
  headers: Headers;
}
