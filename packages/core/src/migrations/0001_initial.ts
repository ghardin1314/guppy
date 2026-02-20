import { SqlClient } from "@effect/sql";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _guppy_threads (
      thread_id TEXT PRIMARY KEY,
      transport TEXT NOT NULL DEFAULT 'cli',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      leaf_id TEXT,
      metadata TEXT DEFAULT '{}'
    )
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _guppy_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES _guppy_threads(thread_id),
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _guppy_schedules (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      schedule_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at INTEGER,
      cron_expression TEXT,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _guppy_deliveries (
      id TEXT PRIMARY KEY,
      schedule_id TEXT REFERENCES _guppy_schedules(id),
      subscriber_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER
    )
  `);
});
