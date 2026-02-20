import { procedure } from "../lib/procedures";
import { z } from "zod";
import { eventIterator, EventPublisher } from "@orpc/server";
import type { AgentEvent, AgentMessage } from "@guppy/core";

const AgentEventPayload = z.object({
  type: z.literal("agent_event"),
  threadId: z.string(),
  event: z.custom<AgentEvent>(),
});

const ThreadOutput = z.object({
  threadId: z.string(),
  transport: z.string(),
  status: z.string(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  metadata: z.string(),
});

const MessageOutput = z.object({
  id: z.string(),
  threadId: z.string(),
  parentId: z.string().nullable(),
  content: z.custom<AgentMessage>(),
  createdAt: z.number(),
});

export const list = procedure
  .route({ method: "GET", path: "/threads" })
  .output(z.array(ThreadOutput))
  .handler(async ({ context }) => {
    const threads = await context.store.listThreads();
    return [...threads];
  });

export const get = procedure
  .route({ method: "GET", path: "/threads/{threadId}" })
  .input(z.object({ threadId: z.string() }))
  .output(ThreadOutput.nullable())
  .handler(async ({ input, context }) => {
    return context.store.getThread(input.threadId);
  });

export const messages = procedure
  .route({ method: "GET", path: "/threads/{threadId}/messages" })
  .input(z.object({ threadId: z.string() }))
  .output(z.array(MessageOutput))
  .handler(async ({ input, context }) => {
    const msgs = await context.store.getContext(input.threadId);
    return [...msgs];
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

export const events = procedure
  .input(z.object({ threadId: z.string() }))
  .output(eventIterator(AgentEventPayload))
  .handler(async function* ({ input, context }) {
    const publisher = new EventPublisher<{
      agentEvent: z.infer<typeof AgentEventPayload>;
    }>();

    const sendFn = (data: string) => {
      publisher.publish("agentEvent", JSON.parse(data));
    };

    await context.sse.addListener(input.threadId, sendFn);
    try {
      yield* publisher.subscribe("agentEvent");
    } finally {
      await context.sse.removeListener(input.threadId, sendFn);
    }
  });
