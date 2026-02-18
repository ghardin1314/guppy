# Guppy: Goals & Design Principles

## What Is Guppy?

A runtime/framework for personal agents deployed as long-running server processes. Agents within Guppy can modify their own environment, improve over time, and interact with the outside world through pluggable transport layers — all while being observed and steered through a live UI.

## Core Goals

### 1. Self-Modifying Agents
Agents can inspect, rewrite, and extend their own behavior at runtime. The system treats agent code as mutable data — not static deployments. An agent that discovers a better strategy can implement it immediately without human intervention or redeployment.

### 2. Hot Reloadability of Everything
Every layer of the system — agent logic, transport bindings, UI components, even runtime configuration — must be hot-reloadable. No restarts. No downtime. The running process is the development environment. This is the foundational constraint that shapes every architectural decision.

### 3. Pluggable Transport Layers
Agents connect to the outside world through transports: Discord, Slack, email, HTTP webhooks, SMS, custom protocols, etc. Transports are first-class, swappable modules. Adding a new channel should never require changes to agent logic.

### 4. Live, Agent-Modifiable UI
A built-in observability layer that the agent itself can modify at runtime. Not just dashboards showing logs — the agent can create custom views, controls, and visualizations to surface what it thinks is important. The UI is another output surface the agent owns.

### 5. Continuous, Autonomous Operation
Guppy processes are meant to run indefinitely. The system must handle crashes gracefully, persist state across restarts, and allow agents to schedule their own future work. Uptime is a feature.

## Design Principles

### Agent-First, Not Developer-First
The primary consumer of Guppy's APIs is the agent, not the human developer. APIs should be discoverable and self-describing so agents can introspect what's available and use it without documentation. Human ergonomics matter but are secondary to agent ergonomics.

### Everything Is a Module
Agent logic, transports, UI components, persistence backends, tool definitions — all are modules with the same lifecycle: load, initialize, hot-reload, teardown. A uniform module contract simplifies the runtime and makes hot-reload universal rather than special-cased.

### State Survives Code
Code changes constantly; state must persist through those changes. The runtime must cleanly separate ephemeral computation from durable state so that reloading an agent's logic never loses its accumulated knowledge, in-progress work, or conversation context.

### Boundaries, Not Guardrails
The system defines clear boundaries (module interfaces, transport protocols, state contracts) but doesn't impose opinionated constraints on what agents can do within those boundaries. The agent is trusted. Guppy is infrastructure, not a cage.

### Observability as a First-Class Concern
Every significant event — state transitions, transport messages, errors, agent decisions — should be observable by default. The system should make it trivially easy to understand what's happening and why, both for humans watching the UI and for agents introspecting their own behavior.

### Fail Gracefully, Recover Automatically
A bad hot-reload shouldn't crash the process. A transport disconnection shouldn't lose messages. A corrupt module should be isolatable. The runtime should prefer degraded operation over total failure and provide clear paths back to healthy state.

### Radical Simplicity
No extra infrastructure beyond what's strictly necessary. Never use two parts when one would do. Prefer a single process with SQLite over a database server. Prefer file watching over a build pipeline. Prefer plain functions over framework abstractions. Complexity must justify itself — if a simpler approach works, it wins. The system should be understandable by reading a small amount of code, not by studying a architecture diagram.

## Non-Goals

- **Multi-tenancy**: Guppy runs one agent (or a cooperating set of agents) per process. Isolation between untrusted agents is out of scope.
- **Distributed clustering**: A single Guppy process runs on a single server. Horizontal scaling is left to external orchestration.
- **Sandboxing**: Agents are trusted code. Guppy doesn't try to prevent agents from accessing the filesystem, network, or system resources.
- **Backwards compatibility during early development**: The API will break. Stability comes after the design solidifies.
