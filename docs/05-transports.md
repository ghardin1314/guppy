# Transports

Transports bridge external messaging channels into the Guppy runtime. They run on boot and stay connected for the lifetime of the process.

## Responsibilities

### 1. Connect
Establish and maintain a connection to the external channel (Discord WebSocket, Slack RTM, IMAP polling, webhook listener, etc.). Runs on boot, reconnects on failure.

### 2. Log Channel History
Record all messages in the channel — not just those directed at the agent. Every message from every participant is written to a channel history store. This runs continuously, whether or not the agent is actively invoked.

### 3. Trigger
Decide when the agent should be invoked. This is transport-specific logic: an @mention in Slack, a DM in Discord, a new email in a thread, a webhook payload. When triggered, the transport sends a message to the orchestrator targeting the appropriate agent thread.

### 4. Sync
On invocation, pull recent channel messages (since the last sync) from the channel history and inject them into the agent thread's context. This ensures the agent sees the full recent conversation flow — not just messages addressed to it. The agent gets context like "Alice said X, Bob replied Y, then Alice asked me Z" rather than just the trigger message.

### 5. Deliver
Receive the agent's final response and send it back to the channel. Only the final message — not tool calls, intermediate thinking, or internal state. Transports may optionally support richer delivery (typing indicators, progress updates) but the baseline is final response only.

### 6. Format
Translate between the external message format and Guppy's internal format in both directions. Inbound: external → internal. Outbound: internal → external. This includes handling attachments, formatting, mentions, threads, etc.

## Channel History

A separate store from the agent's message tree. The channel history is the raw, unprocessed log of everything that happens in a channel. The agent can query it for context beyond what's in its compacted conversation history.

Storage mechanism TBD — could be a fourth core SQLite table, or transport-managed files. The key requirement is that the agent can query it.

## Integration Points (TBD)

The exact interfaces between transports and the orchestrator are still being designed. Open questions:

- **Trigger → Orchestrator**: what does the transport send to the orchestrator when it decides the agent should be invoked? A mailbox message with the trigger context?
- **Sync timing**: does the transport sync channel history into the agent context, or does it hand the raw history to the orchestrator and let it handle injection?
- **Delivery interface**: does the transport subscribe to agent thread events and filter for final responses? Or does the orchestrator explicitly call back into the transport?
- **Multi-message responses**: can the agent send multiple messages back to the channel (e.g., a text response followed by a file upload)?
- **Transport-specific tools**: how are transport tools (like Slack file upload) registered and scoped to the right threads?
