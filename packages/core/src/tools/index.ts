import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool } from "./bash.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";

export { createBashTool } from "./bash.ts";
export { createReadTool } from "./read.ts";
export { createWriteTool } from "./write.ts";
export { createEditTool } from "./edit.ts";
export { resolveSafePath } from "./shared.ts";

/** Creates all 4 base tools (read, write, edit, bash) for the given workspace. */
export function createBaseTools(workspaceDir: string): AgentTool<any>[] {
  return [
    createReadTool(workspaceDir),
    createWriteTool(workspaceDir),
    createEditTool(workspaceDir),
    createBashTool(workspaceDir),
  ];
}
