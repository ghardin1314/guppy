import { procedure } from "../lib/procedures";

export const health = procedure
  .route({ method: "GET", path: "/health" })
  .handler(async () => ({
    status: "ok" as const,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));
