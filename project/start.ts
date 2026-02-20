import {
  Guppy,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  models,
  type AgentTool,
} from "@guppy/core";
import { SseTransportAdapter, SseTransportLive } from "@guppy/transport-sse";
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
    model: models.kimiK25,
    systemPrompt:
      "You are a helpful coding assistant. You have access to tools for reading files and running bash commands. Be concise in your responses. All files you create should go in the ./data directory.",
    tools,
  },
}).register(SseTransportLive);

await guppy.boot();
const sse = new SseTransportAdapter(guppy);
await createServer(workspaceDir, shell, { guppy, sse, router });
