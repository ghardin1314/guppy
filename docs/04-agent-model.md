# Agent Model

## Overview

Guppy uses a virtual actor model for agents. Each transport channel (Slack channel, email thread, Telegram group, etc.) gets its own **agent thread** — a persistent, long-running conversation with its own message history. An **orchestrator** manages thread lifecycles and routes messages between transports, the event bus, and agent threads.

## Agent Threads

An agent thread is a virtual actor. It has:

- A persistent message history (stored in SQLite, compacted as it grows)
- An identity tied to a transport channel (e.g., `slack:#general`, `email:thread-abc`)
- An in-memory runtime state when active (Pi `Agent` instance, loaded context)
- The ability to be suspended to disk and rehydrated on demand

Threads are created lazily — the first message from a new channel creates one. Thread state is always persisted to SQLite, so a thread can be evicted from memory at any time without losing anything.

### Lifecycle

```
Message arrives for thread
  ↓
Orchestrator checks: is thread in memory?
  → No: rehydrate from SQLite, load into memory
  → Yes: dispatch directly
  ↓
Thread processes message via Pi agent loop
  ↓
Response routes back through orchestrator → transport
  ↓
Thread stays in memory (until idle eviction)
```

### Idle Eviction

As a later optimization, threads that haven't received a message since the last restart (or haven't been active for some configurable period) can be evicted from memory. Their full state lives in SQLite. Next message rehydrates them. This is the virtual actor pattern — the orchestrator maintains the illusion that all threads are always running, but only active ones consume memory.

## Thread Mailbox

Agent threads are actors — the only way to interact with them is by sending typed messages to their mailbox. The orchestrator (and by extension, transports and the event bus) never calls methods on a thread directly. It sends a message, and the thread decides how to handle it.

### Message Types

**Prompt** — a new user/external message for the agent to respond to. Enters the conversation history and triggers an LLM call.

**Steering** — interrupt the agent mid-run. Skips remaining tool calls, injects this message, and the agent re-evaluates. Maps to Pi's steering message concept.

**Follow-up** — queue a message to be processed after the current run finishes. Maps to Pi's follow-up message concept.

**Stop** — immediately abort the active LLM call and tool execution. The thread goes idle but stays in memory.

**Event** — a payload from the event bus (scheduled task, cron trigger, inter-thread message). The thread interprets it and decides how to act — likely by constructing a prompt for itself.

This list will grow. The mailbox pattern makes it easy to add new message types without changing the orchestrator or thread internals — just define a new type and add a handler.

### Processing

Threads process mailbox messages sequentially. A thread handles one message at a time. New messages arriving while the thread is busy are queued in the mailbox (except **stop** and **steering**, which interrupt immediately).

## Orchestrator

The orchestrator is plain code, not an LLM. It:

- **Routes inbound messages** from transports to the correct thread mailbox (by transport + channel ID)
- **Routes outbound responses** from agent threads back to the originating transport
- **Manages thread lifecycles** — creates, rehydrates, and evicts threads in memory
- **Dispatches events** from the event bus to their target thread mailbox

The orchestrator maintains a map of active (in-memory) threads. When a message targets a thread that isn't loaded, the orchestrator rehydrates it from SQLite first, then delivers the message to its mailbox.

## Cross-Thread Communication

### Peer Access

Agent threads can read other threads' message history on request. An agent working in Slack can peek into the email thread to get context. This is read-only access to another thread's persisted state in SQLite — the target thread doesn't need to be in memory.

### Triggering Work

Agent threads trigger work on other threads through the event bus. An agent in Slack that needs to "also email this person a summary" emits an event addressed to the email thread. The event bus delivers it, the orchestrator rehydrates the target thread if needed, and that thread handles it.

Threads never call each other directly. The event bus is the only inter-thread communication channel.

## Event Bus Addressing

All events (immediate, scheduled, cron) are addressed to a specific thread. The event bus delivers to the orchestrator, which dispatches to the target thread.

```
Agent Thread A
  → emits event (target: Thread B)
    → Event Bus
      → Orchestrator
        → rehydrate Thread B if needed
          → Thread B processes event
```

## Compaction

As a thread's message history grows, older messages are compacted — summarized by the LLM and replaced with the summary. The full history remains in SQLite for audit/debugging, but the active context sent to the LLM stays within token limits. Compaction strategy is TBD but likely similar to Pi's approach (summarize old messages, keep recent ones verbatim).

## Layered Context

Each agent thread's system prompt is assembled from three layers of markdown files, loaded from specific filesystem paths. More specific layers can override or extend the general ones.

### Global Context
Shared across all threads. Defines the agent's core identity, general instructions, and baseline behavior.
```
context/MEMORY.md
```

### Transport Context
Shared across all threads on a given transport. Defines transport-specific behavior — e.g., how to format messages for Slack vs email, transport-specific conventions, available transport tools.
```
context/transports/slack/MEMORY.md
context/transports/email/MEMORY.md
```

### Thread Context
Specific to a single thread. The agent can modify this file to persist thread-specific notes, preferences, or instructions across compactions. Unlike message history (which gets compacted), thread context survives indefinitely.
```
context/threads/slack/general/MEMORY.md
context/threads/email/thread-abc/MEMORY.md
```

### Assembly Order

When a thread activates, its system prompt is assembled by concatenating the layers:

```
MEMORY.md (global) + MEMORY.md (transport) + MEMORY.md (thread) + skills metadata
```

All layers are optional. A missing file is simply skipped. The agent can modify any of these files (including global) using its write/edit tools.

## Open Questions

- **Thread identity**: is `transport:channel_id` sufficient, or do we need a more flexible addressing scheme?
- **Compaction trigger**: compact on token count threshold? On message count? On demand?
- **Thread-scoped skills**: can individual threads have different skill sets, or do all threads share the same skills directory?
- **Context size budget**: how much of the context window do we allocate to these layers vs conversation history vs skill definitions?
