import type { GuppyContext } from "@guppy/web";
import { os } from "@orpc/server";

/** Base procedure — all procedures derive from this. */
export const procedure = os.$context<GuppyContext>();
