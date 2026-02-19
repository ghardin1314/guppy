import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { Effect, Fiber, Layer, Scope, Exit, Stream } from "effect";
import { getModel } from "@mariozechner/pi-ai";
import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import {
  makeDbLayer,
  ThreadStore,
  ThreadStoreLive,
  PiAgentFactoryLive,
  spawn,
  ThreadMessage,
  type AgentThreadConfig,
  type Thread,
} from "@guppy/core";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";
import { createEditTool } from "./tools/edit.ts";
import { createBashTool } from "./tools/bash.ts";

// -- Paths --------------------------------------------------------------------

const DB_PATH = resolve(import.meta.dir, "data.sqlite");
const WORKSPACE_DIR = resolve(import.meta.dir, "workspace");

// -- Layers -------------------------------------------------------------------

const DbLayer = makeDbLayer(DB_PATH);
const StoreLayer = Layer.provideMerge(ThreadStoreLive, DbLayer);
const AppLayer = Layer.merge(StoreLayer, PiAgentFactoryLive);

// -- Agent config -------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful coding agent. You can read, write, and edit files, and run shell commands.
All file paths are relative to the workspace directory.`;

const tools: AgentTool<any>[] = [
  createReadTool(WORKSPACE_DIR),
  createWriteTool(WORKSPACE_DIR),
  createEditTool(WORKSPACE_DIR),
  createBashTool(WORKSPACE_DIR),
];

const agentConfig: AgentThreadConfig = {
  model: getModel("anthropic", "claude-sonnet-4-5"),
  systemPrompt: SYSTEM_PROMPT,
  tools,
};

// -- Readline -----------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

const askLine = Effect.promise<string>(
  () => new Promise<string>((res) => rl.question("> ", res)),
).pipe(Effect.map((s) => s.trim()));

// -- Event rendering ----------------------------------------------------------

let streamingText = false;

function renderEvent(event: AgentEvent): Effect.Effect<void> {
  return Effect.sync(() => {
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
        console.log(
          `\n[${event.toolName}] ${JSON.stringify(event.args).slice(0, 120)}`,
        );
        break;
      case "tool_execution_end": {
        const result = event.result;
        if (result?.content) {
          for (const block of result.content) {
            if (block.type === "text") {
              const text =
                block.text.length > 500
                  ? block.text.slice(0, 500) +
                    `\n... (${block.text.length} chars)`
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
  });
}

// -- Spawn helper -------------------------------------------------------------

const spawnThread = (threadId: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const handle = yield* spawn(threadId, agentConfig).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    return { scope, handle };
  });

// -- Main ---------------------------------------------------------------------

const main = Effect.gen(function* () {
  const store = yield* ThreadStore;

  let thread: Thread = yield* store.getOrCreateThread("cli", "default");
  let { scope, handle } = yield* spawnThread(thread.id);

  console.log("Effect agent prototype ready.");
  console.log("Commands: /new, /threads, /switch <id>, /quit\n");
  console.log(`Thread: ${thread.id.slice(0, 8)}...\n`);

  let running = true;
  while (running) {
    const input = yield* askLine;
    if (!input) continue;

    // -- Commands -------------------------------------------------------------

    if (input.startsWith("/")) {
      const [cmd, ...args] = input.split(" ");

      switch (cmd) {
        case "/quit":
          running = false;
          break;

        case "/new": {
          yield* Scope.close(scope, Exit.void);
          const channelId = crypto.randomUUID().slice(0, 8);
          thread = yield* store.getOrCreateThread("cli", channelId);
          ({ scope, handle } = yield* spawnThread(thread.id));
          console.log(`New thread: ${thread.id.slice(0, 8)}...`);
          break;
        }

        case "/threads": {
          const threads = yield* store.listThreads("cli");
          if (threads.length === 0) {
            console.log("No threads.");
            break;
          }
          for (const t of threads) {
            const count = yield* store.countMessages(t.id);
            const active = t.id === thread.id ? " ← current" : "";
            console.log(
              `  ${t.id.slice(0, 8)}  ${t.channelId}  ${count} msgs${active}`,
            );
          }
          break;
        }

        case "/switch": {
          const prefix = args[0];
          if (!prefix) {
            console.log("Usage: /switch <id-prefix>");
            break;
          }
          const threads = yield* store.listThreads("cli");
          const match = threads.find((t) => t.id.startsWith(prefix));
          if (!match) {
            console.log(`No thread matching '${prefix}'`);
            break;
          }
          yield* Scope.close(scope, Exit.void);
          thread = match;
          ({ scope, handle } = yield* spawnThread(thread.id));
          console.log(`Switched to thread: ${thread.id.slice(0, 8)}...`);
          break;
        }

        default:
          console.log(`Unknown command: ${cmd}`);
      }
      continue;
    }

    // -- Prompt ---------------------------------------------------------------

    try {
      const eventsFiber = yield* handle.events.pipe(
        Stream.takeUntil((e) => e.type === "agent_end"),
        Stream.runForEach(renderEvent),
        Effect.fork,
      );

      yield* handle.send(ThreadMessage.Prompt({ content: input }));
      yield* Fiber.join(eventsFiber);
    } catch (err) {
      console.error(
        `\nError: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    console.log();
  }

  yield* Scope.close(scope, Exit.void);
  rl.close();
});

// -- Run ----------------------------------------------------------------------

Effect.provide(main, AppLayer).pipe(Effect.runPromise).catch(console.error);
