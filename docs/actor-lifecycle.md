# Actor Lifecycle Management

## Current State

Actors are created on demand by the orchestrator when the first message arrives for a thread. They live until `orchestrator.shutdown()`. No idle eviction, no resource limits.

The actor itself is stateless w.r.t. lifecycle — it owns the agent instance, prompt queue, and event subscription, but makes no decisions about when to tear itself down. `destroy()` is a clean teardown callable by the orchestrator.

## Why Lifecycle Belongs in the Orchestrator

The actor's job is: receive messages, run the agent, post results. Resource management (when to create/destroy actors, memory budgets, eviction policies) is a system-level concern that requires global visibility across all actors. The orchestrator has that visibility.

Reasons:
- **Global limits** (max actors, memory cap) require knowing about all actors at once
- **Eviction policies** (LRU, idle timeout) need a central timer/sweep
- **Health monitoring** (stuck drains, dead agents) is a supervisory concern
- Keeps the actor focused on its single thread — no self-destruction logic

## Planned: Idle Timeout Eviction

After an actor finishes its drain queue and goes idle, the orchestrator starts a timer (default 5min, configurable via `settings.idleTimeoutMs`). On expiry:

1. Actor saves context to store
2. Orchestrator calls `actor.destroy()` — aborts agent, drops subscription, clears queue
3. Orchestrator removes actor from the map

On next message for that thread, a fresh actor is created. Context reloads from `context.jsonl` — transparent to the caller.

```
send("slack:C1:T1", prompt)
  → actor created, agent created, prompt runs
  → drain completes, actor idle
  → 5 min pass, no messages
  → orchestrator destroys actor, removes from map
send("slack:C1:T1", prompt)
  → new actor created, context reloaded from store
  → prompt runs as if nothing happened
```

## Future: Resource Policies

### Max Concurrent Actors
Cap the number of live actors. When limit reached and a new thread needs one:
- Evict the least-recently-active actor (LRU)
- Or reject with backpressure message

### Actor Health Checks
Detect stuck actors (drain loop blocked for too long):
- Periodic sweep checks last activity timestamp
- Force-destroy + post error to thread if stuck beyond threshold

### Per-Actor Memory Tracking
Track agent context size per actor. Evict large-context actors first when under memory pressure. Pairs with compaction — large contexts get compacted before eviction is considered.

### Global Rate Limiting
Throttle total LLM calls across all actors. Useful for cost control and API rate limits. Orchestrator queues actor prompt starts when global budget is exhausted.
