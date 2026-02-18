# Pi Integration

Guppy uses two packages from the Pi agent toolkit. Everything else is built in-house.

## Dependencies

### `@mariozechner/pi-ai`

Unified multi-provider LLM streaming API. Handles:

- Provider registry (Anthropic, OpenAI, Google, Bedrock, Azure, OpenAI-compatible providers)
- Model discovery and capabilities
- Streaming responses (`streamSimple`)
- One-shot completions (`completeSimple`)
- Thinking/reasoning level abstraction across providers

We use this as-is. No reason to build our own LLM client.

### `@mariozechner/pi-agent-core`

The agent loop and its supporting types. Gives us:

- **Agent loop** (`agentLoop` / `agentLoopContinue`) — the prompt → stream → tool call → continue cycle
- **Message types** (`UserMessage`, `AssistantMessage`, `ToolResultMessage`, extensible `AgentMessage`)
- **Tool interface** (`AgentTool`) — typed tool definitions with execute functions
- **Event streaming** (`EventStream`) — async iterable of agent events (message_start, tool_execution, turn_end, etc.)
- **Steering & follow-up messages** — interrupt or extend the agent mid-run
- **Agent class** — stateful wrapper managing message queues, abort/retry, streaming state

The agent core is purely in-memory with zero persistence. This is ideal — we wire it to our own SQLite layer without fighting an existing storage mechanism.

## Not Used

| Package | Why not |
|---------|---------|
| `pi-coding-agent` | Too much coding-agent-specific machinery (session manager, CLI, extensions). We build our own agent from the core primitives. |
| `pi-mom` | Slack bot. Reference only for transport patterns. |
| `pi-web-ui` | May revisit for the UI layer later. |
| `pi-tui` | Terminal UI. Guppy is a server process. |
| `pi-pods` | vLLM deployment. Not relevant. |

## What Guppy Builds

| Concern | Approach |
|---------|----------|
| **Tools** | Reimplement the 4 core tools (read, bash, edit, write) using Bun APIs. Bash runs via `Bun.$`. |
| **Persistence** | SQLite via `bun:sqlite`. Store conversation history, agent memory, scheduled events. |
| **Event bus** | Immediate, scheduled, and cron events. Built on SQLite + runtime scheduler. |
| **Skills** | SKILL.md files loaded into agent context. Filesystem-based discovery. |
| **Transports** | Boot-time code bridging external channels into the agent loop. |
| **UI** | Agent-modifiable web UI served by `Bun.serve()`. |

## Integration Pattern

The event bus sits above Pi's agent. When an event fires (inbound message, scheduled task, cron trigger), Guppy constructs the appropriate context and calls into Pi's agent loop. Pi handles the LLM interaction and tool execution. Guppy persists the results to SQLite and routes any outbound messages back through the originating transport.

```
Event Bus (scheduler, transports, webhooks)
  ↓ triggers
Guppy Runtime (context assembly, state management)
  ↓ calls
Pi Agent Loop (LLM streaming, tool execution)
  ↓ results
Guppy Runtime (persist to SQLite, route responses)
  ↓ sends
Transports (Discord, Slack, etc.)
```

## Open Questions

- **Bun compatibility**: Pi targets Node.js >= 20. Needs early validation that `pi-ai` and `pi-agent-core` run cleanly on Bun.
- **Message type extensions**: what custom `AgentMessage` types does Guppy need beyond the standard three? Transport metadata, event bus payloads, UI notifications?
- **Agent class vs raw loop**: do we use Pi's `Agent` class (stateful, manages queues) or call `agentLoop` directly for more control?
