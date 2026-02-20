/**
 * Thin async wrapper over the Effect-based ThreadStore service.
 * Accepts plain strings at the boundary; branded IDs stay internal.
 */

import { Effect } from "effect";
import type { Guppy } from "./guppy.ts";
import { ThreadStore } from "./repository.ts";
import type { Thread, Message, TransportId, ThreadId } from "./schema.ts";

export interface ThreadStoreAdapter {
  getOrCreateThread(transport: string, threadId: string): Promise<Thread>;
  getThread(threadId: string): Promise<Thread | null>;
  listThreads(transport?: string): Promise<ReadonlyArray<Thread>>;
  insertMessage(
    threadId: string,
    parentId: string | null,
    role: "user" | "assistant" | "tool_result" | "summary",
    content: string,
  ): Promise<Message>;
  getContext(threadId: string): Promise<ReadonlyArray<Message>>;
  countMessages(threadId: string): Promise<number>;
}

export function createThreadStoreAdapter(guppy: Guppy): ThreadStoreAdapter {
  const run = <A>(effect: Effect.Effect<A, unknown, ThreadStore>) =>
    guppy.runEffect(effect);

  return {
    getOrCreateThread: (transport, threadId) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.getOrCreateThread(transport as TransportId, threadId as ThreadId),
        ),
      ),
    getThread: (threadId) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.getThread(threadId as ThreadId),
        ),
      ),
    listThreads: (transport) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.listThreads(transport as TransportId | undefined),
        ),
      ),
    insertMessage: (threadId, parentId, role, content) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.insertMessage(threadId as ThreadId, parentId, role, content),
        ),
      ),
    getContext: (threadId) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.getContext(threadId as ThreadId),
        ),
      ),
    countMessages: (threadId) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.countMessages(threadId as ThreadId),
        ),
      ),
  };
}
