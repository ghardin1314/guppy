import { resolve } from "node:path";
import { openDatabase } from "./db/schema.ts";
import { getOrCreateThread, listThreads, getThread, type ThreadRow } from "./db/threads.ts";
import { countMessages } from "./db/messages.ts";
import { runAgent } from "./agent/loop.ts";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

const DB_PATH = resolve(import.meta.dir, "data.sqlite");
const WORKSPACE_DIR = resolve(import.meta.dir, "workspace");

const db = openDatabase(DB_PATH);
let thread = getOrCreateThread(db, "cli", "default");
let streamingText = false;

console.log("Agent prototype ready. Type a message or use /new, /threads, /switch <id>");
console.log(`Thread: ${thread.id.slice(0, 8)}...\n`);

const prompt = () => process.stdout.write("> ");
prompt();

for await (const line of console) {
  const input = line.trim();
  if (!input) {
    prompt();
    continue;
  }

  // Handle commands
  if (input.startsWith("/")) {
    handleCommand(input);
    prompt();
    continue;
  }

  try {
    await runAgent({
      db,
      threadId: thread.id,
      userInput: input,
      workspaceDir: WORKSPACE_DIR,
      onEvent: handleEvent,
    });
    // Refresh thread state after agent run
    thread = getThread(db, thread.id)!;
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : err}`);
  }

  console.log(); // blank line after response
  prompt();
}

function handleCommand(input: string) {
  const [cmd, ...args] = input.split(" ");

  switch (cmd) {
    case "/new": {
      const channelId = crypto.randomUUID().slice(0, 8);
      thread = getOrCreateThread(db, "cli", channelId);
      console.log(`New thread: ${thread.id.slice(0, 8)}...`);
      break;
    }
    case "/threads": {
      const threads = listThreads(db);
      if (threads.length === 0) {
        console.log("No threads.");
        break;
      }
      for (const t of threads) {
        const msgs = countMessages(db, t.id);
        const active = t.id === thread.id ? " ← current" : "";
        console.log(`  ${t.id.slice(0, 8)}  ${t.channel_id}  ${msgs} msgs${active}`);
      }
      break;
    }
    case "/switch": {
      const prefix = args[0];
      if (!prefix) {
        console.log("Usage: /switch <thread-id-prefix>");
        break;
      }
      const threads = listThreads(db);
      const match = threads.find((t) => t.id.startsWith(prefix));
      if (!match) {
        console.log(`No thread matching '${prefix}'`);
        break;
      }
      thread = match;
      console.log(`Switched to thread: ${thread.id.slice(0, 8)}...`);
      break;
    }
    default:
      console.log(`Unknown command: ${cmd}`);
  }
}

function handleEvent(event: AgentEvent) {
  switch (event.type) {
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        if (!streamingText) {
          streamingText = true;
          process.stdout.write("\n");
        }
        process.stdout.write(ame.delta);
      }
      break;
    }
    case "message_end":
      if (streamingText) {
        process.stdout.write("\n");
        streamingText = false;
      }
      break;
    case "tool_execution_start":
      console.log(`\n[${event.toolName}] ${JSON.stringify(event.args).slice(0, 120)}`);
      break;
    case "tool_execution_end": {
      const result = event.result;
      if (result?.content) {
        for (const block of result.content) {
          if (block.type === "text") {
            const text = block.text.length > 500
              ? block.text.slice(0, 500) + `\n... (${block.text.length} chars)`
              : block.text;
            console.log(`  → ${text}`);
          }
        }
      }
      if (event.isError) {
        console.log(`  [${event.toolName}] ERROR`);
      }
      break;
    }
  }
}
