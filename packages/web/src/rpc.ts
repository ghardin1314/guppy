import type { Guppy } from "@guppy/core";

export interface GuppyContext {
  guppy: Guppy;
  headers: Headers;
}
