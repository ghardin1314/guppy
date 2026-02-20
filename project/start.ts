import { Guppy, getModel } from "@guppy/core";
import { WebsocketTransportLive, WsTransportAdapter } from "@guppy/transport-ws";
import { createServer } from "@guppy/web";
import { createReadTool } from "./tools/read.ts";
import { createBashTool } from "./tools/bash.ts";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// shell.html must be a static import so Bun's bundler processes it.
import shell from "./shell.html";

const workspaceDir = import.meta.dir;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tools: AgentTool<any>[] = [
  createReadTool(workspaceDir),
  createBashTool(workspaceDir),
];

const guppy = Guppy.create({
  projectDir: workspaceDir,
  agent: {
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    systemPrompt: "You are a helpful coding assistant. You have access to tools for reading files and running bash commands. Be concise in your responses.",
    tools,
  },
}).register({ layer: WebsocketTransportLive });

await guppy.boot();
const ws = new WsTransportAdapter(guppy);
await createServer(workspaceDir, shell, { guppy, ws });
