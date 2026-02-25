import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Thread } from "chat";
import type { Sandbox } from "../sandbox";
import { createBashTool } from "./bash";
import { createReadTool } from "./read";
import { createWriteTool } from "./write";
import { createEditTool } from "./edit";
import { createUploadTool } from "./upload";
import { createHistoryTool } from "./history";

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
    createHistoryTool(deps.thread),
  ];
}

export { createBashTool } from "./bash";
export { createReadTool } from "./read";
export { createWriteTool } from "./write";
export { createEditTool } from "./edit";
export { createUploadTool } from "./upload";
export { createHistoryTool } from "./history";
