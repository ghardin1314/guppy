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

export const prompt = procedure
  .route({ method: "POST", path: "/threads/prompt" })
  .input(z.object({ threadId: z.string(), content: z.string() }))
  .handler(async ({ input, context }) => {
    await context.sse.prompt(input.threadId, input.content);
    return { ok: true };
  });

export const stop = procedure
  .route({ method: "POST", path: "/threads/stop" })
  .input(z.object({ threadId: z.string() }))
  .handler(async ({ input, context }) => {
    await context.sse.stop(input.threadId);
    return { ok: true };
  });

export const steer = procedure
  .route({ method: "POST", path: "/threads/steer" })
  .input(z.object({ threadId: z.string(), content: z.string() }))
  .handler(async ({ input, context }) => {
    await context.sse.steer(input.threadId, input.content);
    return { ok: true };
  });
