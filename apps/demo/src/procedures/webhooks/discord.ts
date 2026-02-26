import { os } from "@orpc/server";
import type { Context } from "../context";

export const discord = os
  .$context<Context>()
  .route({ method: "POST", path: "/webhooks/discord" })
  .handler(({ context }) => context.chat.webhooks.discord(context.request));
