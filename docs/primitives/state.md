# State

All persistent state lives in a single SQLite database (`bun:sqlite`) plus files on disk.

## Core Tables

The framework owns three tables. These are the minimum needed to support the agent model and event bus.

### threads

One row per agent thread (virtual actor).

| Column | Type | Description |
|--------|------|-------------|
| id | text PK | Unique thread identifier |
| transport | text | Transport name (slack, email, etc.) |
| channel_id | text | Channel/thread identifier within the transport |
| status | text | active, idle |
| created_at | integer | Unix timestamp |
| last_active_at | integer | Unix timestamp, used for idle eviction |
| leaf_id | text | Current message tree tip (FK to messages) |
| metadata | text | JSON blob for extensibility |

Unique constraint on `(transport, channel_id)`.

### messages

Conversation history for all threads. Uses a tree structure (inspired by Pi) where each message references its parent, enabling branching and compaction.

| Column | Type | Description |
|--------|------|-------------|
| id | text PK | Unique message identifier |
| thread_id | text FK | Which thread this belongs to |
| parent_id | text | ID of the parent message (null for root) |
| role | text | user, assistant, tool_result, summary |
| content | text | Message content (JSON for structured content like tool calls) |
| created_at | integer | Unix timestamp |

Each thread also tracks a `leaf_id` (in the threads table) pointing to the current tip of the conversation.

**Context assembly**: walk from `leaf_id` to root via `parent_id`, collecting messages along the path. This gives the linear conversation history for the LLM.

**Branching**: to explore an alternative path, set `leaf_id` to an earlier message and continue from there. The old branch remains in the tree — no data is deleted. Useful for retry, rollback, or the agent experimenting with different approaches.

**Compaction**: insert a summary message as a child of the oldest message to keep, then reparent the continuation onto it. Old messages stay in the tree for audit but are no longer on the active path from leaf to root.

**Context query**: a recursive CTE walks from leaf to the last summary (or root) efficiently. Each step is a primary key lookup.

```sql
WITH RECURSIVE context AS (
  SELECT *, 0 AS stop FROM messages WHERE id = :leaf_id
  UNION ALL
  SELECT m.*, CASE WHEN m.role = 'summary' THEN 1 ELSE 0 END
  FROM messages m
  JOIN context c ON m.id = c.parent_id
  WHERE c.stop = 0
)
SELECT * FROM context ORDER BY created_at;
```

This includes the summary as the effective context root and stops walking further. For a compacted conversation (20-100 active messages), this is trivially fast. An index on `parent_id` is only needed if we want to traverse the tree downward (e.g., for a branching UI).

### events

The event bus queue. All three event types in one table.

| Column | Type | Description |
|--------|------|-------------|
| id | text PK | Unique event identifier |
| type | text | immediate, scheduled, cron |
| target_thread_id | text FK | Which thread this event is addressed to |
| source_thread_id | text | Which thread created this event (nullable) |
| payload | text | JSON event data |
| status | text | pending, delivered, canceled, failed |
| scheduled_at | integer | When to deliver (null for immediate) |
| cron_expression | text | Cron schedule (null for non-cron) |
| last_fired_at | integer | Last delivery time for cron events |
| created_at | integer | Unix timestamp |
| delivered_at | integer | When it was delivered (null if pending) |

Cron events stay `status = pending` and keep firing until canceled. Each delivery updates `last_fired_at`. The scheduler polls for due events.

## Agent-Created Tables

The agent has full access to the SQLite database and can create its own tables for any purpose. The framework's core tables use a `guppy_` prefix (or similar) to avoid collisions.

Examples of what an agent might build:
- A contacts table for tracking people across channels
- A bookmarks/links database
- A task tracker
- A cache for API responses
- Custom analytics tables

The agent creates and queries these tables through the bash tool (or a SQLite skill). The framework doesn't manage, migrate, or compact agent-created tables — the agent owns them entirely.

## Files on Disk

Unstructured persistent data lives as files:

- **Layered context** — global.md, transport.md, thread.md (see agent model doc)
- **Skills** — SKILL.md files
- **Agent notes** — anything the agent writes for its own reference
- **Generated artifacts** — scripts, reports, exports, etc.

## Open Questions

- **Table prefix**: `guppy_` prefix for framework tables to namespace them away from agent tables? Or a separate database file?
- **Compaction strategy**: summarize after N messages? After token count exceeds threshold? Both?
- **Message content format**: store raw text, or always JSON? JSON is more structured but adds serialization overhead for simple text messages.
- **Event delivery**: poll interval for the scheduler? Or use SQLite triggers/hooks?
