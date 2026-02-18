/**
 * Entry point — equivalent to `guppy start`.
 *
 * Framework code lives in ./framework/ (owned by the guppy package).
 * Project files live in ./project/ (scaffolded by guppy init, agent-modifiable).
 *
 * Usage: bun --hot start.ts [project-dir]
 */

import { resolve } from "path";
import { createServer } from "./framework/server.ts";

// In real Guppy this would be cwd or --dir flag
const projectDir = process.argv[2]
  ? resolve(process.argv[2])
  : `${import.meta.dir}/project`;

// shell.html must be a static import so Bun's bundler processes it.
// In real Guppy, this would be generated or resolved from the project dir.
import shell from "./framework/shell.html";

await createServer(projectDir, shell);
