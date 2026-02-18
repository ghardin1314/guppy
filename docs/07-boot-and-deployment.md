# Boot & Deployment

## Installation

Requires Bun. Install the CLI globally:

```bash
bun add -g guppy
```

## `guppy init`

Interactive setup wizard, run in the target directory (or pass `--dir <path>`):

```bash
guppy init
# or
guppy init --dir /home/user/my-agent
```

The wizard:

1. Asks which LLM provider to use (Anthropic, OpenAI, Google, etc.)
2. Prompts for API credentials
3. Asks which transports to enable (Slack, Discord, email, etc.)
4. Prompts for transport credentials
5. Scaffolds the project directory and SQLite database
6. Writes credentials to `.env` (auto-loaded by Bun, `.gitignore`'d)
7. Creates a systemd user service file

## Project Structure

After `guppy init`:

```
my-agent/
├── .env.enc                # Encrypted credentials if no OS keyring (gitignored, see primitives/credentials.md)
├── guppy.db                # SQLite database
├── context/
│   ├── MEMORY.md           # Global agent context
│   ├── transports/         # Per-transport context
│   │   └── slack/
│   │       └── MEMORY.md
│   └── threads/            # Per-thread context (agent-created)
│       └── slack/
│           └── general/
│               └── MEMORY.md
├── skills/                 # SKILL.md directories
├── transports/             # Transport boot scripts
│   └── slack.ts
├── pages/                  # UI pages (HTML + TSX)
│   ├── index.html          # Thread overview (default)
│   ├── thread/[id].html    # Conversation view (default)
│   └── events.html         # Event bus view (default)
├── routes/                 # API route handlers
└── data/                   # Agent-created files, notes, artifacts
```

## CLI Commands

### `guppy init`
Scaffold a new project. Interactive wizard. Also initializes a git repo with a `.gitignore` (covering `.env`, `guppy.db`, `guppy.db-wal`, `guppy.db-shm`).

### `guppy start`
Boot the framework. This is what systemd calls.

### `guppy transport add <name>`
Add a transport post-init. Prompts for credentials, drops the transport file into `transports/`, updates `.env`.

### `guppy status`
Check if running, show active threads, transport connections, upcoming events.

## Boot Sequence

What `guppy start` does, in order:

```
1. Open SQLite database
   ↓
2. Start orchestrator (thread lifecycle manager)
   ↓  (parallel from here)
3a. Boot transports (run each file in transports/)
3b. Start event bus scheduler (poll for due events)
3c. Start web server (Bun.serve, file router, WebSocket)
3d. Start auto-commit timer
   ↓
4. Ready — accepting messages
```

SQLite must be open before anything else. After that, transports, the event bus, and the web server can start in parallel since they all just need the orchestrator and database to be available.

Skills and context files are not loaded at boot. They're read on demand during the agent loop — skills when assembling the LLM context, context files when a thread activates.

## Auto-Commit

The project is a git repo. A background timer (default: every hour) checks for uncommitted changes and auto-commits them. This gives the agent's self-modifications a built-in version history — if it breaks a skill, a UI page, or a MEMORY.md file, you can always roll back.

The auto-commit covers everything the agent can modify: skills, context files, UI pages, routes, data files. The `.gitignore` excludes secrets (`.env`) and the database (`guppy.db`*) since SQLite is backed up separately.

Database backups and git history together mean the full agent state is recoverable at any point in time.

## systemd

`guppy init` creates a user-level systemd service (no sudo required):

```ini
# ~/.config/systemd/user/guppy.service
[Unit]
Description=Guppy Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/user/my-agent
ExecStart=/home/user/.bun/bin/guppy start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user enable guppy
systemctl --user start guppy
```

**Lingering**: user services stop on logout unless lingering is enabled. The init wizard checks for this and prompts:

```bash
# Requires sudo (one-time)
loginctl enable-linger $USER
```

## Updates

Updates require a restart:

```bash
bun update -g guppy
systemctl --user restart guppy
```

### What Happens on Restart

The boot sequence must handle a world that may have changed since last run:

1. **Schema migrations** — the SQLite database may need new tables or columns from an updated Guppy version. The framework checks a schema version on boot and runs migrations if needed. Migrations are forward-only.
2. **In-flight events** — scheduled/cron events that were due while the process was down need to fire. The event bus scheduler checks for overdue events on boot and delivers them.
3. **Transport reconnection** — transports re-establish external connections. Channel history may have gaps from the downtime. Transports that support backfill (e.g., Slack's conversation history API) should sync missed messages into the channel history log.
4. **Active threads** — all threads are evicted from memory on shutdown (they're always persisted to SQLite). On restart, they rehydrate on demand when the next message arrives. No special recovery needed.
5. **Pending mailbox messages** — if a thread had queued messages when the process died, those are lost (they're in-memory). Transports will redeliver on reconnect, and the event bus will redeliver overdue events, so this should self-heal.

### Version Compatibility

The SQLite database and file system are the durable state. Guppy versions must be able to read state written by previous versions. Breaking changes to the schema require migrations. The framework should refuse to start if it encounters a schema version newer than it understands (downgrade protection).

### Agent-Created Schema

The agent can create its own tables and modify its own schema at runtime. This introduces a class of problems that framework migrations don't have — the agent might write broken SQL, create a table that conflicts with a future framework table, or corrupt its own data.

Mitigations:

- **Namespace separation** — framework tables use a reserved prefix (e.g., `_guppy_`). The agent is free to create anything else. Framework migrations never touch non-prefixed tables.
- **WAL mode** — SQLite in WAL (Write-Ahead Logging) mode so a bad write from the agent doesn't corrupt the database for the framework.
- **Backups on boot** — copy the database file before running framework migrations or on a regular schedule. If the agent corrupts its own tables, a recent backup exists.
- **No rollback magic** — if the agent breaks its own tables, it's the agent's problem to fix. The framework provides the backup, the agent has the tools (bash/SQL) to restore. This is consistent with "boundaries, not guardrails."

## Open Questions

- **Multiple instances**: can you run multiple Guppy agents on one server? Different ports, different project directories, different service names?
- **Logs**: systemd captures stdout/stderr via `journalctl --user -u guppy`. Is that sufficient or do we want file-based logging too?
- **Transport discovery**: on boot, the framework runs every `.ts` file in `transports/`. Is there a convention for disabling a transport without deleting it? (e.g., rename to `.disabled`)
- **Graceful shutdown**: should `guppy stop` wait for active agent loops to finish before exiting? Or hard-kill after a timeout?
