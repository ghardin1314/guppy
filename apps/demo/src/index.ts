import { createDiscordAdapter } from "@chat-adapter/discord";
// import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  Guppy,
  createBashTool,
  createEditTool,
  createReadTool,
  createUploadTool,
  createWriteTool,
  createHostSandbox,
} from "@guppy/core";
import { getModel } from "@mariozechner/pi-ai";
import { Chat } from "chat";
import { join } from "node:path";
import { buildSystemPrompt } from "./system-prompt";

// -- Config --

const DATA_DIR = join(import.meta.dir, "..", "data");
const PORT = Number(process.env.PORT) || 3000;
const BOT_NAME = "Guppy Local";

// -- Core wiring --

const chat = new Chat({
  userName: BOT_NAME,
  adapters: {
    // slack: createSlackAdapter(),
    discord: createDiscordAdapter(),
    // @guppy:adapters
  },
  state: createMemoryState(),
});

const sandbox = createHostSandbox(process.cwd());

const guppy = new Guppy({
  dataDir: DATA_DIR,
  chat,
  agent: {
    model: getModel("anthropic", "claude-sonnet-4-5"),
    modelSettings: { thinkingLevel: "high" },
    tools: [
      createBashTool(sandbox),
      createReadTool(sandbox.workspacePath),
      createWriteTool(sandbox.workspacePath),
      createEditTool(sandbox.workspacePath),
      createUploadTool(sandbox.workspacePath, chat),
    ],
    systemPrompt: (ctx) => buildSystemPrompt(ctx, { dataDir: DATA_DIR, sandbox }),
  },
});

// -- Chat handlers --

chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await guppy.logMessage(thread.id, message);
  guppy.send(thread.id, {
    type: "prompt",
    text: message.text,
    thread,
    message,
  });
});

chat.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  await guppy.logMessage(thread.id, message);
  guppy.send(thread.id, {
    type: "prompt",
    text: message.text,
    thread,
    message,
  });
});

chat.onNewMessage(/.*/, (thread, message) => {
  guppy.logPassiveMessage(thread.id, message);
});

// -- Discord Gateway --
// Connects the WebSocket for regular messages & reactions.
// (HTTP interactions alone only handle slash commands & verification pings.)
// TODO: file chat-sdk issue — startGatewayListener API is serverless-oriented;
// needs a persistent-process mode that doesn't require duration/waitUntil.
await chat.initialize();
const discord = chat.getAdapter("discord");

const GATEWAY_CYCLE = 12 * 60 * 60 * 1000; // 12h
await discord
  .startGatewayListener({ waitUntil: () => {} }, GATEWAY_CYCLE)
  .then(() => {
    console.log("Gateway connected");
  })
  .catch((error) => {
    console.error("Error connecting gateway:", error);
  });
setInterval(
  () => {
    discord
      .startGatewayListener({ waitUntil: () => {} }, GATEWAY_CYCLE)
      .then(() => {
        console.log("Gateway reconnected");
      })
      .catch((error) => {
        console.error("Error reconnecting gateway:", error);
      });
  },
  // Reconnect 1 second early to ensure we always have a connection
  GATEWAY_CYCLE - 1000,
);

// -- HTTP server --

const server = Bun.serve({
  port: PORT,
  routes: {
    "/api/webhooks/*": async (request) => {
      const adapter = request.url.split("/").pop();
      if (!adapter) return new Response("Not Found", { status: 404 });
      const handler = chat.webhooks[adapter as keyof typeof chat.webhooks];

      if (!handler) return new Response("Not Found", { status: 404 });
      return handler(request);
    },
  },
});

console.log(`[demo] Server listening on http://localhost:${server.port}`);

// -- Graceful shutdown --

function shutdown() {
  console.log("[demo] Shutting down...");
  guppy.shutdown();
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
