import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _guppy_threads (
      id TEXT PRIMARY KEY,
      transport TEXT NOT NULL DEFAULT 'cli',
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      leaf_id TEXT,
      metadata TEXT DEFAULT '{}',
      UNIQUE(transport, channel_id)
    )
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _guppy_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES _guppy_threads(id),
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _guppy_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      source_thread_id TEXT,
      payload TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at INTEGER,
      cron_expression TEXT,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    )
  `);
});
