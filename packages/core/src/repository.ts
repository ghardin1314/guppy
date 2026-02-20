/**
 * Unified persistence service for threads, messages, and context retrieval.
 */

import { Clock, Context, Effect, Layer } from "effect";
import { SqlClient, SqlError } from "@effect/sql";
import { type Thread, type Message, type TransportId, type ThreadId } from "./schema.ts";
import { nanoid } from "./id.ts";

// -- Service interface --------------------------------------------------------

export interface ThreadStoreService {
  readonly getOrCreateThread: (
    transport: TransportId,
    threadId: ThreadId,
  ) => Effect.Effect<Thread, SqlError.SqlError>;

  readonly getThread: (threadId: ThreadId) => Effect.Effect<Thread | null, SqlError.SqlError>;

  readonly listThreads: (
    transport?: TransportId,
  ) => Effect.Effect<ReadonlyArray<Thread>, SqlError.SqlError>;

  readonly insertMessage: (
    threadId: ThreadId,
    parentId: string | null,
    role: Message["role"],
    content: string,
  ) => Effect.Effect<Message, SqlError.SqlError>;

  /** Walk the parent chain from leaf to root, returning messages oldest-first. */
  readonly getContext: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Message>, SqlError.SqlError>;

  readonly countMessages: (threadId: ThreadId) => Effect.Effect<number, SqlError.SqlError>;
}

// -- Tag ----------------------------------------------------------------------

export class ThreadStore extends Context.Tag("@guppy/core/ThreadStore")<
  ThreadStore,
  ThreadStoreService
>() {}

// -- Live implementation ------------------------------------------------------

export const ThreadStoreLive = Layer.effect(
  ThreadStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return ThreadStore.of({
      getOrCreateThread: (transport, threadId) =>
        Effect.gen(function* () {
          const existing = yield* sql<Thread>`
            SELECT * FROM _guppy_threads
            WHERE thread_id = ${threadId}
            LIMIT 1
          `;
          if (existing[0]) return existing[0];

          const ts = yield* Clock.currentTimeMillis;
          yield* sql`
            INSERT INTO _guppy_threads (thread_id, transport, status, created_at, last_active_at)
            VALUES (${threadId}, ${transport}, 'idle', ${ts}, ${ts})
          `;
          const rows = yield* sql<Thread>`
            SELECT * FROM _guppy_threads WHERE thread_id = ${threadId}
          `;
          return rows[0]!;
        }),

      getThread: (threadId) =>
        Effect.gen(function* () {
          const rows = yield* sql<Thread>`
            SELECT * FROM _guppy_threads WHERE thread_id = ${threadId} LIMIT 1
          `;
          return rows[0] ?? null;
        }),

      listThreads: (transport) =>
        transport
          ? sql<Thread>`
              SELECT * FROM _guppy_threads
              WHERE transport = ${transport}
              ORDER BY last_active_at DESC
            `
          : sql<Thread>`
              SELECT * FROM _guppy_threads ORDER BY last_active_at DESC
            `,

      insertMessage: (threadId, parentId, role, content) =>
        Effect.gen(function* () {
          const id = yield* nanoid();
          const ts = yield* Clock.currentTimeMillis;
          yield* sql`
            INSERT INTO _guppy_messages (id, thread_id, parent_id, role, content, created_at)
            VALUES (${id}, ${threadId}, ${parentId}, ${role}, ${content}, ${ts})
          `;
          yield* sql`
            UPDATE _guppy_threads
            SET leaf_id = ${id}, last_active_at = ${ts}
            WHERE thread_id = ${threadId}
          `;
          const rows = yield* sql<Message>`
            SELECT * FROM _guppy_messages WHERE id = ${id}
          `;
          return rows[0]!;
        }),

      getContext: (threadId) =>
        Effect.gen(function* () {
          const thread = yield* sql<{ leafId: string | null }>`
            SELECT leaf_id FROM _guppy_threads WHERE thread_id = ${threadId} LIMIT 1
          `;
          const leafId = thread[0]?.leafId;
          if (!leafId) return [];

          const messages = yield* sql<Message>`
            WITH RECURSIVE chain AS (
              SELECT m.*, 0 AS depth FROM _guppy_messages m
              WHERE m.id = ${leafId}
              UNION ALL
              SELECT p.*, ch.depth + 1 FROM _guppy_messages p
              JOIN chain ch ON ch.parent_id = p.id
            )
            SELECT * FROM chain ORDER BY depth DESC
          `;
          return messages;
        }),

      countMessages: (threadId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ count: number }>`
            SELECT COUNT(*) as count FROM _guppy_messages
            WHERE thread_id = ${threadId}
          `;
          return rows[0]!.count;
        }),
    });
  }),
);
