# Credentials

Secrets (API keys, transport tokens, etc.) must never be stored in plain text. The agent also needs the ability to store its own credentials at runtime.

## Storage

**Preferred**: Bun's built-in secrets API (`Bun.secrets`), backed by OS credential managers (Keychain on macOS, libsecret on Linux). Encrypted at rest by the OS, per-user access control.

This is the preferred approach but it's an open question whether we can reliably set up the OS keyring on headless servers during `guppy init`. Needs testing. If it turns out to be impractical, we'll drop this approach entirely and use encrypted environment variables instead. We will not support both — one mechanism only.

## Registry

Bun's secrets API has no `list()` method. We track secret names (not values) in a SQLite table so the framework and agent know what's available:

```
_guppy_secrets: name, description, created_at
```

## Operations

### Framework
- Transports read their credentials on boot via `secrets.get()`
- LLM provider keys are read on each agent loop invocation
- When the agent runs a bash command that needs a credential, the framework retrieves it and injects it as an env var into the child process — the secret never hits disk

### Agent
- The agent can **set** credentials but not **read** them back
- Writes to both the secrets API and the registry table
- Use case: agent integrates with a new service, stores the API key for future use
- Credentials are only exposed when injected as env vars into bash execution — never returned as tool output
- This doesn't prevent a determined agent from exfiltrating via bash, but it prevents accidental exposure in conversation context or logs

### CLI
- `guppy secret set <name>` — store a secret (prompts for value)
- `guppy secret delete <name>` — remove a secret
- `guppy secret list` — list secret names from registry (not values)

## Open Questions

- **OS keyring on headless servers**: libsecret needs a D-Bus session bus and a keyring daemon. Modern GNOME Keyring (46+) works without X11 but isn't installed by default on most servers. Can `guppy init` set this up, or is it too much friction?
- **Encrypted file format**: if we fall back to a file, what encryption scheme? Key derived from a master password? Machine-specific key?
- **Credential scoping**: should credentials be tagged with which tools/transports they're injected into, or just injected by name into any bash invocation?
