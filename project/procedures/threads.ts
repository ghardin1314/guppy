import { procedure } from "../lib/procedures";
import { z } from "zod";

const ThreadOutput = z.object({
  threadId: z.string(),
  transport: z.string(),
  status: z.string(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  metadata: z.string(),
});

export const list = procedure
  .route({ method: "GET", path: "/threads" })
  .output(z.array(ThreadOutput))
  .handler(async ({ context }) => {
    const rows = await context.guppy.query<z.infer<typeof ThreadOutput>>(
      "SELECT thread_id, transport, status, created_at, last_active_at, metadata FROM _guppy_threads ORDER BY last_active_at DESC",
    );
    return [...rows];
  });

export const get = procedure
  .route({ method: "GET", path: "/threads/{threadId}" })
  .input(z.object({ threadId: z.string() }))
  .output(ThreadOutput.nullable())
  .handler(async ({ input, context }) => {
    const rows = await context.guppy.query<z.infer<typeof ThreadOutput>>(
      "SELECT thread_id, transport, status, created_at, last_active_at, metadata FROM _guppy_threads WHERE thread_id = ? LIMIT 1",
      input.threadId,
    );
    return rows[0] ?? null;
  });
