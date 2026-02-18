# Tools vs Skills

Two distinct concepts that work together.

## Tools

The core execution primitives, provided by Pi's agent framework. These are the only things the agent can actually *do*:

- **read** — read files
- **bash** — execute shell commands (reimplemented to run via `Bun.$`)
- **edit** — modify files
- **write** — create files

Transport-specific tools may be added as needed (e.g., a Slack file upload tool), but the base set is intentionally minimal. Everything else the agent needs to do is composed from these four.

## Skills

Markdown files that teach the agent *how* to use its tools to accomplish higher-level tasks. Skills are not executable — they're context loaded into the agent's prompt.

We adopt the **SKILL.md** open standard ([agentskills.io/specification](https://agentskills.io/specification)), which is supported by 26+ platforms including Claude Code, Cursor, OpenAI Codex, Gemini CLI, and GitHub Copilot. This gives us portability and access to the existing skill ecosystem.

### Format

A skill is a directory with a `SKILL.md` file:

```
skill-name/
├── SKILL.md          # Required — frontmatter + instructions
├── scripts/          # Optional — executables the skill references
├── references/       # Optional — docs loaded on demand
└── assets/           # Optional — static resources
```

### Frontmatter

```yaml
---
name: weather-lookup
description: |
  Look up current weather for a location.
  Use when the user asks about weather conditions.
license: MIT
compatibility: Requires curl
metadata:
  author: guppy
  version: "1.0"
---
```

Required fields: `name`, `description`. Name must be lowercase + hyphens, matching the directory name.

### Progressive Disclosure

Not all skill content is loaded at once:

1. **Metadata** (~100 tokens) — `name` + `description` loaded at startup for all skills
2. **Instructions** (<5000 tokens) — full SKILL.md body loaded when skill is activated
3. **Resources** (on demand) — `scripts/`, `references/`, `assets/` loaded only when needed

This keeps context usage manageable as the skill library grows.

### Package Management

Skills are installable via `npx skills`:

```bash
npx skills add owner/repo              # Install from GitHub
npx skills add owner/repo/skill-name   # Install specific skill
npx skills init                        # Create new skill
```

A discovery directory exists at [skills.sh](https://skills.sh/).

## Self-Modification

Agents can create, modify, or delete skill files using the write/edit tools. New skills become available on the next loop iteration. This is the primary mechanism for agents to extend their own capabilities — they learn something, write a SKILL.md for it, and can use it going forward.

Since we use the standard format, agent-created skills are portable to other platforms.

## Open Questions

- **Skill selection**: how does the agent (or runtime) decide which skills to load into context for a given turn? Name matching? Embedding search? Let the LLM pick from the metadata list?
- **Approval**: should some skills require human approval before the agent executes them? Or is that a concern for the agent loop, not the skill primitive?
