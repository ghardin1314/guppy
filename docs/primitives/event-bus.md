# Event Bus

The event bus is how agents trigger work — for themselves, for other agents, now or in the future.

## Event Types

### Immediate
Fire now, handle now. An agent triggering another agent, an external webhook arriving, any situation where something needs to happen right away.

### Scheduled (One-Off)
Fire at a specific future time. An agent saying "follow up on this tomorrow at 9AM" or "check this URL in 2 hours." Executes once and is done.

### Scheduled (Cron)
Fire on a recurring schedule. "Summarize my inbox every Monday at 8AM." Keeps firing until canceled.

## Operations

Agents can:

- **Emit** an immediate event (targeting self or another agent)
- **Schedule** a one-off event for a future time (targeting self or another agent)
- **Schedule** a recurring cron event (targeting self or another agent)
- **Query** upcoming/pending events (filter by agent, type, time range)
- **Cancel** a pending or recurring event
- **Query** past and canceled events (nice-to-have, for introspection/debugging)

## Open Questions

- **Event shape**: what data does an event carry? At minimum: target agent, event type, payload. What else?
- **Failure handling**: what happens when a scheduled event fires but the target agent errors? Retry? Dead letter? Just log it?
- **Concurrency**: can an agent receive a new event while it's still handling one? Or does it process events sequentially?
- **Addressing**: how are agents and events identified? String names? UUIDs?
- **Storage**: SQLite is the obvious backend for scheduled/cron events (they need to survive restarts). Immediate events may or may not need persistence.
