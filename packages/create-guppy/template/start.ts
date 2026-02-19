import { createServer } from "@guppy/web";

// shell.html must be a static import so Bun's bundler processes it.
import shell from "./shell.html";

await createServer(import.meta.dir, shell);
