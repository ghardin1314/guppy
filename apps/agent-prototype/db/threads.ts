import type { Database } from "bun:sqlite";

export interface ThreadRow {
  id: string;
  transport: string;
  channel_id: string;
  status: string;
  created_at: number;
  last_active_at: number;
  leaf_id: string | null;
  metadata: string;
}

export function getOrCreateThread(
  db: Database,
  transport: string,
  channelId: string
): ThreadRow {
  const existing = db
    .query<ThreadRow, [string, string]>(
      "SELECT * FROM _guppy_threads WHERE transport = ? AND channel_id = ?"
    )
    .get(transport, channelId);

  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = Date.now();
  db.run(
    `INSERT INTO _guppy_threads (id, transport, channel_id, status, created_at, last_active_at)
     VALUES (?, ?, ?, 'idle', ?, ?)`,
    [id, transport, channelId, now, now]
  );

  return db
    .query<ThreadRow, [string]>("SELECT * FROM _guppy_threads WHERE id = ?")
    .get(id)!;
}

export function getThread(db: Database, id: string): ThreadRow | null {
  return db
    .query<ThreadRow, [string]>("SELECT * FROM _guppy_threads WHERE id = ?")
    .get(id);
}

export function listThreads(db: Database): ThreadRow[] {
  return db
    .query<ThreadRow, []>(
      "SELECT * FROM _guppy_threads ORDER BY last_active_at DESC"
    )
    .all();
}

export function updateThreadLeaf(
  db: Database,
  threadId: string,
  leafId: string
): void {
  db.run(
    "UPDATE _guppy_threads SET leaf_id = ?, last_active_at = ? WHERE id = ?",
    [leafId, Date.now(), threadId]
  );
}
