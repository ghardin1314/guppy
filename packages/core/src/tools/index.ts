import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Thread } from "chat";
import type { Sandbox } from "../sandbox";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createReadTool } from "./read";
import { createUploadTool } from "./upload";
import { createWriteTool } from "./write";

export interface ToolDeps {
  sandbox: Sandbox;
  workspacePath: string;
  thread: Thread;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildTools(deps: ToolDeps): AgentTool<any>[] {
  return [
    createBashTool(deps.sandbox),
    createReadTool(deps.workspacePath),
    createWriteTool(deps.workspacePath),
    createEditTool(deps.workspacePath),
    createUploadTool(deps.workspacePath, deps.thread),
  ];
}

export { createBashTool } from "./bash";
export { createEditTool } from "./edit";
export { createReadTool } from "./read";
export { createUploadTool } from "./upload";
export { createWriteTool } from "./write";
