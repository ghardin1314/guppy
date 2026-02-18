# Infrastructure

Guppy requires exactly two pieces of infrastructure:

## File System

The file system is the registry, configuration layer, and integration surface. Everything the runtime needs to know lives as files on disk:

- **Tool/skill definitions**: markdown files describing available capabilities and how to invoke them
- **UI components/routes**: files served by Bun, hot-reloaded via HMR
- **Transport code**: scripts that run on boot to bridge external channels
- **Agent-generated artifacts**: new tools, modified UI, any other files the agent creates

The agent modifies its own environment by writing to the file system. No APIs needed — just files.

## SQLite

Single database for all persistent state:

- Conversation history
- Agent memory / accumulated knowledge
- Scheduled tasks
- Any other durable state the agent needs across restarts

Accessed via `bun:sqlite`. No external database server. The database file lives alongside the rest of the project on the file system.

## That's It

No message broker. No Redis. No container orchestration. No build pipeline. A Bun process, a directory of files, and a SQLite database. Everything else is built on top of these two.
