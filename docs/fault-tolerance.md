# Fault Tolerance

## Philosophy

Fail gracefully, never crash the process. Every error becomes a descriptive message in the thread. systemd `Restart=always` is the last-resort fallback — but the process should always reboot into a valid state.

No circuit breakers, no quarantine, no unsent message queues. Complexity lives only where data loss is possible.

---

## Failure Surface

### External Dependencies

| Component | Failure Mode | Strategy |
|---|---|---|
| **LLM API** | Rate limit, timeout, 500s, overloaded | Retry with backoff (provider SDK handles transient HTTP; actor retries application-level failures) |
| **Chat platform API** | Rate limit on reply, network error | Retry reply with backoff; on final failure, log and drop |
| **Tool execution** | Hang, OOM, non-zero exit | AbortSignal timeout; error fed back to LLM as tool result, loop continues |
| **Filesystem** | Disk full, permission error | Catch write errors, keep in-memory state, retry on next turn |

### Internal Components

| Component | Failure Mode | Strategy |
|---|---|---|
| **Orchestrator** | Uncaught exception in routing | Should never happen (fire-and-forget, no async work). If it does, process restarts via systemd. |
| **Actor** | Agent run throws | Try/catch at actor boundary, post error to thread, continue draining queue |
| **Context compaction** | LLM summarization fails | Retry as normal LLM error; if unrecoverable, keep uncompacted context |
| **System prompt assembly** | Missing files | Silently omit missing memory/identity/skills (already handled) |

---

## Mechanisms

### 1. Atomic Context Writes

`context.jsonl` is the most critical file — it holds the LLM's working memory. A full rewrite that gets interrupted mid-write corrupts the file, and `loadContext()` returns `[]`. The agent loses its entire conversation history.

**Solution**: Write to a temp file, then atomically rename over the original. `rename()` is atomic on POSIX filesystems.

```typescript
saveContext(threadId, messages):
  dir = threadDir(threadId)
  tmpFile = join(dir, "context.jsonl.tmp")
  targetFile = join(dir, "context.jsonl")
  writeFileSync(tmpFile, content)
  renameSync(tmpFile, targetFile)
```

If the process dies during `writeFileSync`, only the `.tmp` file is corrupt — the original `context.jsonl` is untouched. On next boot, `loadContext()` reads the intact original.

### 2. Actor-Level Try/Catch

Every agent run is wrapped in try/catch at the actor's drain loop. No error propagates past the actor boundary.

```
drainQueue():
  while queue not empty:
    item = queue.shift()
    try:
      activate if needed
      run agent with item
      save context
    catch (error):
      post descriptive error to thread
      log full error with stack trace
      // continue draining — next prompt still runs
  start idle timer
```

Error messages posted to the thread should be descriptive:
- LLM API failure: "I'm having trouble reaching my AI provider. Try again in a moment."
- Tool timeout: "A command I was running timed out. Let me know if you'd like me to try again."
- Context corruption: "I had trouble loading our conversation history. Starting fresh for this thread."
- Unknown: "Something went wrong: {error.message}. Try sending your message again."

### 3. LLM Retry (Application-Level)

The LLM provider SDK (Anthropic, OpenAI) handles transient HTTP errors silently — rate limits, 5xx, connection resets. We get this for free.

Above that, the actor retries application-level LLM failures (errors that survive the provider's built-in retry):

- Detect retryable errors: `overloaded_error`, rate limit, 429, 500–504, connection failures
- Exponential backoff: `baseDelayMs * 2^attempt` (default: 2s, 4s, 8s)
- Max retries: 3 (configurable via `settings.json`)
- On final failure: post error message to thread, move on
- Context overflow: not retried — handled by compaction (`transformContext`)

Pattern ported from pi-agent-core's `AgentSession`: on retryable error, remove the error message from context, backoff, call `agent.continue()`.

### 4. Transport Reply Retry

When posting the agent's response back to the chat platform:

- Retry on rate limit (respect `retryAfterMs` from chat SDK's `RateLimitError`) and 5xx
- Max 3 retries with exponential backoff
- On final failure: log the error, drop the reply
- Stale replies are worse than no reply — don't persist unsent messages

### 5. Tool Execution Safety

Already designed via AbortSignal and the sandbox abstraction:

- Hard timeout per tool call (default 120s)
- Tool errors caught and returned to LLM as error tool results — agent loop continues
- Per pi-agent-core's pattern: tool errors don't crash the agent loop, the LLM sees the error and adapts
- Process tree killed on abort (no zombie processes)

---

## Reboot Into Valid State

On process restart (systemd or manual), the system must boot into a consistent state with zero manual intervention.

| Component | Recovery |
|---|---|
| **context.jsonl** | Atomic writes guarantee file is never corrupt. `.tmp` file ignored on load. |
| **log.jsonl** | Append-only. Partial last line is the worst case — next append works normally. |
| **In-memory actor state** | Lost. Actors recreated on demand when next message arrives. |
| **Queued prompts** | Lost. User sends another message. Acceptable for a chat bot. |
| **In-flight agent run** | Aborted. Partial work saved at last `turn_end` checkpoint. |
| **Attachment downloads** | Incomplete files may remain. Non-critical, no cleanup needed. |
| **Memory/identity files** | Read fresh from disk each run. Always current. |
| **Settings** | Loaded on startup. Restart picks up changes. |

---

## What We Don't Do

- **No circuit breakers** — errors are per-thread, isolated by the actor model. A failing thread doesn't affect others.
- **No quarantine** — just post the error and move on. Next message retries naturally.
- **No unsent message queue** — stale bot replies are confusing. Drop and let the user retry.
- **No distributed locking** — single instance assumption. Chat SDK's lock is irrelevant (handlers return immediately).
- **No WAL / append-only context** — atomic rename is sufficient. WAL adds complexity for no real gain at this scale.
- **No graceful shutdown handler** — systemd sends SIGTERM, process dies, restarts clean. Atomic writes ensure no corruption.
