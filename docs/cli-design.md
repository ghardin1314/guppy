# Guppy CLI — Design

## Overview

Single CLI binary: `guppy`. Three commands:

| Command | Purpose |
|---|---|
| `guppy create` | Interactive scaffolding — new project from scratch |
| `guppy add transport` | Add a transport to an existing project (partial re-scaffold) |
| `guppy restart` | Restart the systemd service |

Package: `@guppy/cli` (also published as `guppy` on npm for `bunx guppy create`).

All commands are interactive by default but support non-interactive usage via flags. Every interactive prompt has a corresponding flag — if all required flags are provided, the CLI skips prompts entirely.

---

## `guppy create`

Interactive flow that scaffolds a complete project, installs deps, and configures systemd.

### Non-Interactive Usage

```bash
guppy create my-agent \
  --transport slack \
  --transport discord \
  --state memory \
  --sandbox host \
  --env SLACK_BOT_TOKEN=xoxb-... \
  --env SLACK_SIGNING_SECRET=... \
  --env DISCORD_BOT_TOKEN=...
```

When all required flags are provided, prompts are skipped. Partial flags are allowed — the CLI prompts only for missing values.

### Prompts

```
? Project name: my-agent
? Which transports? (multi-select)
  ◉ Slack
  ◯ Microsoft Teams
  ◯ Google Chat
  ◯ Discord
? State backend?
  ◉ Memory (development)
  ◯ Redis (production)
? Sandbox mode?
  ◉ Host (direct execution)
  ◯ Docker (isolated container)
```

After transport selection, the CLI prompts for each transport's required credentials and provides setup doc links:

```
── Slack Setup ──
Docs: https://api.slack.com/apps

? Bot Token (xoxb-...): ****
? Signing Secret: ****
```

Each transport defines its own required env vars and doc URL (see [Transport Registry](#transport-registry)).

### Scaffold Output

```
my-agent/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Type-safe env config (only selected transport vars)
│   ├── procedures/
│   │   ├── index.ts          # Router composition (only selected transports)
│   │   ├── health.ts         # GET /health
│   │   └── webhooks/
│   │       └── slack.ts      # POST /webhooks/slack
├── data/                     # Runtime data (gitignored)
│   ├── IDENTITY.md           # Agent identity/personality
│   ├── MEMORY.md             # Global memory
│   ├── events/
│   └── skills/               # Global skills
├── my-agent.service          # systemd unit file
├── .env                      # Populated with entered credentials
├── package.json
├── tsconfig.json
└── Dockerfile                # Only if Docker sandbox selected
```

### Post-Scaffold (automatic)

After writing files, the CLI runs:

1. `bun install`
2. Copy `{name}.service` → `~/.config/systemd/user/{name}.service`
3. `systemctl --user daemon-reload`
4. `systemctl --user enable {name}`

Then prints:

```
✓ my-agent scaffolded and service installed

  cd my-agent
  guppy restart        # start the service
  bun run dev          # or run in dev mode (auto-restart on file change)
```

---

## `guppy add transport`

Adds a transport to an existing project. Uses the same scaffold internals as `create` — just scoped to one transport.

### Usage

```bash
# Interactive
guppy add transport [--path ./my-agent]

# Non-interactive
guppy add transport --name teams \
  --env TEAMS_APP_ID=... \
  --env TEAMS_APP_PASSWORD=... \
  [--path ./my-agent]
```

`--path` defaults to cwd. When `--name` and all required `--env` values are provided, prompts are skipped.

### Flow

1. **Detect existing project** — read `package.json` and `src/config.ts` to determine which transports are already configured
2. **Prompt** — show only transports not yet added:
   ```
   ? Which transport to add?
     ◯ Microsoft Teams
     ◯ Google Chat
     ◯ Discord
   ```
3. **Prompt for credentials** — same per-transport credential prompts as `create`, with doc links
4. **Scaffold** — generate/update files:
   - Create `src/procedures/webhooks/{transport}.ts`
   - Update `src/procedures/index.ts` — add import + router entry
   - Update `src/config.ts` — add transport env vars
   - Update `src/index.ts` — add adapter import, add to `Chat` adapters config, add webhook handler
   - Append to `.env`
   - Add `@chat-adapter/{transport}` to `package.json` dependencies
5. **Install** — `bun install`
6. **Print** — remind user to restart:
   ```
   ✓ Teams transport added

     guppy restart    # restart to pick up changes
   ```

### Shared Scaffold Engine

Both `create` and `add transport` use the same underlying scaffold functions. The engine is additive — it can generate a full project or patch an existing one.

```typescript
interface ScaffoldOptions {
  projectName: string;
  projectPath: string;
  transports: TransportConfig[];   // what to add
  stateBackend: "memory" | "redis";
  sandbox: "host" | "docker";
  mode: "create" | "add";         // create = full scaffold, add = patch
}
```

For `mode: "add"`, the engine:
- Reads existing files before modifying (doesn't overwrite non-transport code)
- Inserts imports/config at marked locations (or uses AST-based insertion)
- Only touches transport-related sections

#### Code Insertion Strategy

Scaffolded files contain comment markers for insertion points:

```typescript
// src/index.ts
import { createSlackAdapter } from "@chat-adapter/slack";
// @guppy:adapter-imports

const chat = new Chat({
  userName: config.botName,
  adapters: {
    slack: createSlackAdapter({
      botToken: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
    }),
    // @guppy:adapters
  },
  state: createMemoryState(),
});
```

```typescript
// src/procedures/index.ts
import { slack } from "./webhooks/slack";
// @guppy:webhook-imports

export const router = {
  health,
  webhooks: {
    slack,
    // @guppy:webhooks
  },
};
```

```typescript
// src/config.ts
slack: {
  botToken: env("SLACK_BOT_TOKEN"),
  signingSecret: env("SLACK_SIGNING_SECRET"),
},
// @guppy:transport-config
```

`add transport` finds these markers and inserts the new transport's code before them. If markers are missing (user deleted them), the CLI errors with a message explaining what to add manually.

---

## `guppy restart`

Restarts the systemd service for the project.

### Usage

```
guppy restart [--path ./my-agent]
```

`--path` defaults to cwd.

### Behavior

1. Resolve service name from `package.json` `name` field (or `.service` file in project root)
2. Run `systemctl --user restart {service}`
3. Wait briefly, check status
4. Print result:
   ```
   ✓ my-agent restarted (pid 12345)
   ```
   Or on failure:
   ```
   ✗ my-agent failed to start
     journalctl --user -u my-agent -n 20
   ```

---

## Transport Registry

Each transport is defined as a registry entry. This drives prompts, scaffolding, and doc links.

```typescript
interface TransportDefinition {
  id: string;                          // "slack", "teams", "discord", "gchat"
  displayName: string;                 // "Slack", "Microsoft Teams", etc.
  docsUrl: string;                     // Setup documentation link
  adapterPackage: string;              // "@chat-adapter/slack"
  credentials: CredentialField[];      // What to prompt for
  scaffoldAdapter: ScaffoldFn;         // Generates adapter config code
  scaffoldWebhook: ScaffoldFn;         // Generates webhook procedure code
  scaffoldConfig: ScaffoldFn;          // Generates config.ts entries
}

interface CredentialField {
  key: string;          // env var name: "SLACK_BOT_TOKEN"
  prompt: string;       // display: "Bot Token (xoxb-...)"
  secret: boolean;      // mask input
}
```

Example:

```typescript
const slack: TransportDefinition = {
  id: "slack",
  displayName: "Slack",
  docsUrl: "https://api.slack.com/apps",
  adapterPackage: "@chat-adapter/slack",
  credentials: [
    { key: "SLACK_BOT_TOKEN", prompt: "Bot Token (xoxb-...)", secret: true },
    { key: "SLACK_SIGNING_SECRET", prompt: "Signing Secret", secret: true },
  ],
  scaffoldAdapter: (config) => `
    slack: createSlackAdapter({
      botToken: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
    }),`,
  scaffoldWebhook: (config) => /* webhook procedure template */,
  scaffoldConfig: (config) => /* config.ts entries */,
};
```

Adding a new transport to Guppy = adding a new registry entry. No other code changes needed.

---

## Package Structure

```
packages/cli/
├── src/
│   ├── index.ts              # Entry point, command routing
│   ├── commands/
│   │   ├── create.ts         # guppy create
│   │   ├── add-transport.ts  # guppy add transport
│   │   └── restart.ts        # guppy restart
│   ├── scaffold/
│   │   ├── engine.ts         # Shared scaffold engine (create + add)
│   │   ├── templates.ts      # File templates (index.ts, config.ts, etc.)
│   │   └── markers.ts        # Comment marker insertion logic
│   ├── transports/
│   │   ├── index.ts          # Transport registry
│   │   ├── slack.ts
│   │   ├── teams.ts
│   │   ├── discord.ts
│   │   └── gchat.ts
│   └── prompts.ts            # Interactive prompt helpers
├── package.json
└── tsconfig.json
```

---

## Dependencies

- **[@clack/prompts](https://github.com/bombshell-elements/clack)** — interactive CLI prompts (multi-select, text input, password, spinners)
- **No AST manipulation** — comment markers + string insertion. Simple, predictable, inspectable.
