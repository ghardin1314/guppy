/**
 * Thin async wrapper over the Effect-based ThreadStore service.
 * Accepts plain strings at the boundary; branded IDs stay internal.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Effect } from "effect";
import type { Guppy } from "./guppy.ts";
import { ThreadStore } from "./repository.ts";
import {
  Message,
  Thread,
  ThreadId,
  TransportId,
} from "./schema.ts";

export interface ThreadStoreAdapter {
  getOrCreateThread(transport: string, threadId: string): Promise<Thread>;
  getThread(threadId: string): Promise<Thread | null>;
  listThreads(transport?: string): Promise<ReadonlyArray<Thread>>;
  insertMessage(
    threadId: string,
    parentId: string | null,
    content: AgentMessage,
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
          s.getOrCreateThread(
            TransportId.make(transport),
            ThreadId.make(threadId),
          ),
        ),
      ),
    getThread: (threadId) =>
      run(
        Effect.flatMap(ThreadStore, (s) => s.getThread(threadId as ThreadId)),
      ),
    listThreads: (transport) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.listThreads(transport ? TransportId.make(transport) : undefined),
        ),
      ),
    insertMessage: (threadId, parentId, content) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.insertMessage(ThreadId.make(threadId), parentId, content),
        ),
      ),
    getContext: (threadId) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.getContext(ThreadId.make(threadId)),
        ),
      ),
    countMessages: (threadId) =>
      run(
        Effect.flatMap(ThreadStore, (s) =>
          s.countMessages(ThreadId.make(threadId)),
        ),
      ),
  };
}
