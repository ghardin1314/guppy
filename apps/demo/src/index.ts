import { Chat, ConsoleLogger } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createMemoryState } from "@chat-adapter/state-memory";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import {
  EventBus,
  Orchestrator,
  Store,
  createHostSandbox,
} from "@guppy/core";
import { join } from "node:path";
import { createAgentFactory } from "./agent-factory";
import { getModel } from "@mariozechner/pi-ai";
import { settings } from "./settings";
import { router } from "./procedures";

// -- Config --

const DATA_DIR = join(import.meta.dir, "..", "data");
const PORT = Number(process.env.PORT) || 3000;
const BOT_NAME = "guppy";

// -- Adapters (conditional on env vars) --

const logger = new ConsoleLogger("info");

const adapters: Record<string, ReturnType<typeof createSlackAdapter> | ReturnType<typeof createDiscordAdapter>> = {};

if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_SIGNING_SECRET) {
  adapters.slack = createSlackAdapter({
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    logger,
  });
  console.log("[demo] Slack adapter enabled");
}

if (
  process.env.DISCORD_BOT_TOKEN &&
  process.env.DISCORD_PUBLIC_KEY &&
  process.env.DISCORD_APPLICATION_ID
) {
  adapters.discord = createDiscordAdapter({
    botToken: process.env.DISCORD_BOT_TOKEN,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    logger,
  });
  console.log("[demo] Discord adapter enabled");
}

if (Object.keys(adapters).length === 0) {
  console.error("[demo] No adapters configured. Set SLACK_* or DISCORD_* env vars.");
  process.exit(1);
}

// -- Core wiring --

const state = createMemoryState();

const chat = new Chat({
  userName: BOT_NAME,
  adapters,
  state,
  logger,
});

const store = new Store({ dataDir: DATA_DIR });
const sandbox = createHostSandbox(process.cwd());

const model = getModel("anthropic", "claude-sonnet-4-5");

const agentFactory = createAgentFactory({
  dataDir: DATA_DIR,
  sandbox,
  settings,
  model,
});

const orchestrator = new Orchestrator({
  store,
  agentFactory,
  settings,
  chat,
});

// -- Event Bus --

const eventsDir = join(DATA_DIR, "events");
const eventBus = new EventBus(eventsDir, (target, formattedText) => {
  if ("threadId" in target) {
    orchestrator.send(target.threadId, {
      type: "prompt",
      text: formattedText,
      thread: null!, // Event-triggered prompts reuse existing actor thread
    });
  } else {
    orchestrator.sendToChannel(target.adapterId, target.channelId, formattedText);
  }
});

// -- Chat handlers --

chat.onNewMention(async (thread, message) => {
  await thread.subscribe();
  store.logMessage(thread.id, message);
  orchestrator.send(thread.id, {
    type: "prompt",
    text: message.text,
    thread,
    message,
  });
});

chat.onSubscribedMessage(async (thread, message) => {
  if (message.author.isMe) return;
  store.logMessage(thread.id, message);
  orchestrator.send(thread.id, {
    type: "prompt",
    text: message.text,
    thread,
    message,
  });
});

// -- HTTP server --

const handler = new OpenAPIHandler(router);

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const { matched, response } = await handler.handle(request, {
      context: { chat, request },
    });
    if (matched) return response;
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[demo] Server listening on http://localhost:${server.port}`);

// -- Start services --

eventBus.start();

// -- Graceful shutdown --

function shutdown() {
  console.log("[demo] Shutting down...");
  orchestrator.shutdown();
  eventBus.stop();
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
