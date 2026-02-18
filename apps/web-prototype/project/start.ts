/**
 * Entry point — equivalent to `guppy start`.
 *
 * In a real project, framework imports come from the "guppy" package.
 * Here they reference ../framework/ since this is the prototype.
 *
 * Usage: bun --hot project/start.ts
 */

import { createServer } from "../framework/server.ts";

// shell.html must be a static import so Bun's bundler processes it.
import shell from "./shell.html";

await createServer(import.meta.dir, shell);
