import {
  Guppy,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  getModel,
  type AgentTool,
} from "@guppy/core";
import {
  WebsocketTransportLive,
  WsTransportAdapter,
} from "@guppy/transport-ws";
import { createServer } from "@guppy/web";
import { router } from "./procedures/index";

// shell.html must be a static import so Bun's bundler processes it.
import shell from "./shell.html";

const workspaceDir = import.meta.dir;
const tools: AgentTool<any>[] = [
  createReadTool(workspaceDir),
  createWriteTool(workspaceDir),
  createEditTool(workspaceDir),
  createBashTool(workspaceDir),
];

const guppy = Guppy.create({
  projectDir: workspaceDir,
  agent: {
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    systemPrompt:
      "You are a helpful coding assistant. You have access to tools for reading files and running bash commands. Be concise in your responses.",
    tools,
  },
}).register(WebsocketTransportLive);

await guppy.boot();
const ws = new WsTransportAdapter(guppy);
await createServer(workspaceDir, shell, { guppy, ws, router });
