import { os } from "@orpc/server";
import type { Context } from "../context";

export const slack = os
  .$context<Context>()
  .route({ method: "POST", path: "/webhooks/slack" })
  .handler(({ context }) => context.chat.webhooks.slack(context.request));
