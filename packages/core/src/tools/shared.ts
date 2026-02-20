import { resolve, normalize } from "node:path";

/**
 * Resolves a user-provided path against the workspace dir.
 * Throws if the resolved path escapes the workspace.
 */
export function resolveSafePath(workspaceDir: string, userPath: string): string {
  const abs = resolve(workspaceDir, userPath);
  const normalizedWorkspace = normalize(workspaceDir);
  if (!abs.startsWith(normalizedWorkspace)) {
    throw new Error(`Path escapes workspace: ${userPath}`);
  }
  return abs;
}
