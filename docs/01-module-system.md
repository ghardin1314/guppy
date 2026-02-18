# Module System

There is no formal module system. Guppy's runtime watches files on the filesystem and understands them by their export shape. There are four kinds of things:

## Tools

Plain files that export a tool definition. Stateless — no lifecycle, no init/teardown. The runtime watches tool files and re-imports them on change. The next time the agent invokes a tool, it gets the latest version.

Tools describe themselves (name, parameters, description) so the agent can discover and invoke them without prior knowledge. Adding a new tool means dropping a file into the tools directory.

Hot-reloadable: yes, trivially (stateless).

## UI Components / Routes

Files that define UI views, controls, or route handlers. Served by `Bun.serve()` and reloaded via Bun's built-in HMR. The agent can create, modify, or delete these files at runtime to change what the UI shows.

Hot-reloadable: yes, via Bun HMR.

## Transports

Code that runs on boot to bridge external messaging channels (Discord, Slack, webhooks, etc.) into the agent loop. Transports establish connections, listen for inbound messages, and provide a way to send outbound messages.

Transports are not hot-reloaded. They run once at process start. To add a new transport, drop the file into the filesystem and restart. To change one, edit and restart.

This is a deliberate simplicity tradeoff. Transports hold connection state that's awkward to reload, and they change infrequently. If this decision proves wrong, transport hot-reload can be added later without changing the other pieces.

Hot-reloadable: no (restart required).

## Agent Loop

The core framework itself. Not a user-defined module — it's the runtime's event loop that receives messages from transports, manages conversation state, calls the LLM, invokes tools, and routes responses back out. This is Guppy, not a plugin to Guppy.

Hot-reloadable: no (it's the framework).

## How It Works

At a high level:

1. Transports boot and establish external connections
2. Tool and UI directories are watched for file changes
3. The agent loop receives messages from transports
4. On tool/UI file change, the new version is used on next invocation
5. Agent state persists to SQLite so it survives restarts

There is no module registry, no lifecycle hooks, no dependency graph. Files exist or they don't. The runtime reads them when it needs them.

How this maps to processes is an open question. Could be a single Bun process, could be separate processes for the web server, agent loop, and background jobs. The design shouldn't assume either way — the file-based approach works regardless of process topology.

## Open Questions

- **File organization**: flat directories (`tools/`, `ui/`, `transports/`) or something else?
- **Tool discovery**: does the agent scan the tools directory, or does the runtime build a tool catalog and hand it to the agent?
- **Transport → agent interface**: what's the common message shape that transports normalize into?
- **Can the agent modify transport files?** It can modify tool and UI files. Transports require a restart, so self-modifying transport code would need the agent to trigger a restart — worth designing for or not?
