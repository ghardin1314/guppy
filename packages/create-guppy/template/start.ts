import { Guppy, getModel } from "@guppy/core";
import { WebsocketTransportLive, WsTransportAdapter } from "@guppy/transport-ws";
import { createServer } from "@guppy/web";

// shell.html must be a static import so Bun's bundler processes it.
import shell from "./shell.html";

const guppy = Guppy.create({
  projectDir: import.meta.dir,
  agent: {
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    systemPrompt: "You are a helpful assistant.",
  },
}).register({ layer: WebsocketTransportLive });

await guppy.boot();
const ws = new WsTransportAdapter(guppy);
await createServer(import.meta.dir, shell, { guppy, ws });
