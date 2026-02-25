# CLAUDE.md

## Build

```bash
bun install          # install deps
bun run build        # build all packages (turborepo)
bun run typecheck    # type-check all packages
```

## Reference Source Code

`.context/` contains git-cloned reference repos (not part of this repo's source):

| Folder | Repo | What to look for |
|---|---|---|
| `.context/chat/` | [vercel/chat](https://github.com/vercel/chat) | Chat SDK — adapters (Slack/Teams/GChat), state adapters, message types, mdast formatting, thread model |
| `.context/pi-mono/` | [badlogic/pi-mono](https://github.com/badlogic/pi-mono) | Mom bot — pi-agent-core, bash execution, skills, event bus, memory, context management |

Search these when you need to understand APIs we're wrapping or porting.

## Project Structure

- `packages/` — monorepo packages (`@guppy/core`, `@guppy/web`, `@guppy/cli`)
- `docs/` — design docs (`core-design.md`, `cli-design.md`, `system-prompt-design.md`)
- `SPEC.md` — project spec and vision
