import type { Database } from "bun:sqlite";
import { updateThreadLeaf } from "./threads.ts";

export interface MessageRow {
  id: string;
  thread_id: string;
  parent_id: string | null;
  role: string;
  content: string; // JSON
  created_at: number;
}

/**
 * Insert a message into the tree. Links it as child of the current leaf,
 * then updates the thread's leaf_id.
 */
export function insertMessage(
  db: Database,
  threadId: string,
  currentLeafId: string | null,
  role: string,
  content: unknown
): MessageRow {
  const id = crypto.randomUUID();
  const now = Date.now();
  const contentJson = JSON.stringify(content);

  db.run(
    `INSERT INTO _guppy_messages (id, thread_id, parent_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, threadId, currentLeafId, role, contentJson, now]
  );

  updateThreadLeaf(db, threadId, id);

  return { id, thread_id: threadId, parent_id: currentLeafId, role, content: contentJson, created_at: now };
}

/**
 * Walk from leaf to root (or last summary), return messages in chronological order.
 */
export function getContext(db: Database, leafId: string): MessageRow[] {
  return db
    .query<MessageRow, [string]>(
      `WITH RECURSIVE context AS (
        SELECT rowid AS rn, *, 0 AS stop FROM _guppy_messages WHERE id = ?
        UNION ALL
        SELECT m.rowid AS rn, m.*, CASE WHEN m.role = 'summary' THEN 1 ELSE 0 END
        FROM _guppy_messages m
        JOIN context c ON m.id = c.parent_id
        WHERE c.stop = 0
      )
      SELECT id, thread_id, parent_id, role, content, created_at
      FROM context ORDER BY rn`
    )
    .all(leafId);
}

/**
 * Count messages in a thread.
 */
export function countMessages(db: Database, threadId: string): number {
  return db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM _guppy_messages WHERE thread_id = ?"
    )
    .get(threadId)!.count;
}
