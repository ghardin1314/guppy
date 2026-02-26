import { os } from "@orpc/server";
import type { Context } from "./context";

export const health = os
  .$context<Context>()
  .route({ method: "GET", path: "/health" })
  .handler(() => ({ status: "ok", uptime: process.uptime() }));
