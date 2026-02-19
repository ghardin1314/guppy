import {
  EventBus,
  EventBusLive,
  EventStore,
  EventStoreLive,
  makeDbLayer,
  Orchestrator,
  PiAgentFactoryLive,
  ThreadStore,
  ThreadStoreLive,
  TransportMap,
  TransportRegistryLive,
  type AgentThreadConfig,
  type GuppyEvent,
} from "@guppy/core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { DateTime, Effect, Layer } from "effect";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  TerminalTransport,
  TerminalTransportLive,
} from "./terminal-transport.ts";
import { createBashTool } from "./tools/bash.ts";
import { createEditTool } from "./tools/edit.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";

// -- Paths --------------------------------------------------------------------

const DB_PATH = resolve(import.meta.dir, "data.sqlite");
const WORKSPACE_DIR = resolve(import.meta.dir, "workspace");

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

// -- Layers -------------------------------------------------------------------

const DbLayer = makeDbLayer(DB_PATH);
const StoreLayer = Layer.provideMerge(ThreadStoreLive, DbLayer);
const EventStoreLayer = Layer.provideMerge(EventStoreLive, DbLayer);
const BusLayer = Layer.provideMerge(EventBusLive, EventStoreLayer);

const RegistryLayer = TransportRegistryLive;

const TransportMapLayer = Layer.provide(
  TransportMap.DefaultWithoutDependencies,
  RegistryLayer,
);

const OrchestratorLayer = Layer.provide(
  Orchestrator.layer(agentConfig),
  Layer.mergeAll(StoreLayer, PiAgentFactoryLive, TransportMapLayer),
);

const TerminalLayer = Layer.provide(
  TerminalTransportLive,
  Layer.mergeAll(OrchestratorLayer, RegistryLayer),
);

const AppLayer = Layer.mergeAll(
  StoreLayer,
  OrchestratorLayer,
  TerminalLayer,
  BusLayer,
);

// -- Readline -----------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

const readLine = (prompt: string) =>
  Effect.async<string>((resume) => {
    const ac = new AbortController();
    rl.question(prompt, { signal: ac.signal }, (answer) => {
      resume(Effect.succeed(answer.trim()));
    });
    return Effect.sync(() => ac.abort());
  });

const askLine = readLine("> ");

/**
 * After sending a prompt/followup, race agent completion against
 * a steering input loop. Typing mid-stream sends a steering message;
 * typing "/stop" aborts the agent.
 */
const waitWithSteering = (channelId: string) =>
  Effect.gen(function* () {
    const t = yield* TerminalTransport;
    yield* Effect.race(
      t.waitForAgentEnd,
      Effect.gen(function* () {
        while (true) {
          const line = yield* readLine("");
          if (!line) continue;
          if (line === "/stop") {
            yield* t.stop(channelId);
          } else {
            yield* t.steer(channelId, line);
          }
        }
      }),
    );
  });

// -- Main ---------------------------------------------------------------------

const makeEvent = (
  channelId: string,
  payload: string,
): GuppyEvent => ({
  type: "agent.message",
  targetThreadId: channelId,
  sourceThreadId: null,
  payload,
});

const main = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const t = yield* TerminalTransport;
  const bus = yield* EventBus;
  const eventStore = yield* EventStore;

  // Deliver scheduled events as agent prompts
  yield* bus.subscribe("terminal-scheduler", "agent.*", (event) =>
    Effect.gen(function* () {
      console.log(`\n[scheduled] delivering: ${event.payload}`);
      yield* t.prompt(event.targetThreadId, event.payload);
    }).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => console.error("[schedule error]", e)),
      ),
    ),
  );

  let channelId = "default";
  let thread = yield* store.getOrCreateThread("terminal", channelId);

  console.log("Effect agent prototype ready.");
  console.log(
    "Commands: /new, /threads, /switch <id>, /followup <text>, /quit",
  );
  console.log("Schedule: /schedule <dur> <msg>, /cron <5-fields> <msg>");
  console.log("         /schedules, /cancel <id>");
  console.log("Type mid-stream to steer. /stop to abort.\n");
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
          channelId = crypto.randomUUID().slice(0, 8);
          thread = yield* store.getOrCreateThread("terminal", channelId);
          console.log(`New thread: ${thread.id.slice(0, 8)}...`);
          break;
        }

        case "/threads": {
          const threads = yield* store.listThreads("terminal");
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
          const threads = yield* store.listThreads("terminal");
          const match = threads.find((t) => t.id.startsWith(prefix));
          if (!match) {
            console.log(`No thread matching '${prefix}'`);
            break;
          }
          thread = match;
          channelId = thread.channelId;
          console.log(`Switched to thread: ${thread.id.slice(0, 8)}...`);
          break;
        }

        case "/followup": {
          const content = args.join(" ");
          if (!content) {
            console.log("Usage: /followup <text>");
            break;
          }
          yield* t.followUp(channelId, content);
          yield* waitWithSteering(channelId);
          console.log();
          break;
        }

        case "/stop":
          console.log("(no active stream)");
          break;

        case "/schedule": {
          const durStr = args[0];
          const message = args.slice(1).join(" ");
          if (!durStr || !message) {
            console.log("Usage: /schedule <duration> <message>");
            console.log("  e.g. /schedule 30s remind me about tests");
            break;
          }
          const durMatch = durStr.match(/^(\d+)(s|m)$/);
          if (!durMatch) {
            console.log("Duration must be like: 30s, 5m");
            break;
          }
          const ms =
            parseInt(durMatch[1]!) * (durMatch[2] === "m" ? 60000 : 1000);
          const scheduledAt = DateTime.unsafeMakeZoned(Date.now() + ms, {
            timeZone: "UTC",
          });
          const sched = yield* bus
            .schedule(makeEvent(channelId, message), {
              type: "delayed",
              scheduledAt,
            })
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() => {
                  console.log(`Schedule error: ${e}`);
                  return null;
                }),
              ),
            );
          if (sched) {
            console.log(
              `Scheduled ${sched.id.slice(0, 8)} in ${durStr}: "${message}"`,
            );
          }
          break;
        }

        case "/cron": {
          if (args.length < 6) {
            console.log("Usage: /cron <min> <hr> <day> <mon> <wday> <message>");
            console.log("  e.g. /cron * * * * * check system status");
            break;
          }
          const cronExpr = args.slice(0, 5).join(" ");
          const message = args.slice(5).join(" ");
          if (!message) {
            console.log("Missing message after cron expression");
            break;
          }
          const sched = yield* bus
            .schedule(makeEvent(channelId, message), {
              type: "cron",
              cronExpression: cronExpr,
            })
            .pipe(
              Effect.catchAll((e) =>
                Effect.sync(() => {
                  console.log(`Cron error: ${e}`);
                  return null;
                }),
              ),
            );
          if (sched) {
            console.log(
              `Cron ${sched.id.slice(0, 8)} [${cronExpr}]: "${message}"`,
            );
          }
          break;
        }

        case "/schedules": {
          const delayed = yield* eventStore.getPendingSchedules("delayed");
          const crons = yield* eventStore.getPendingSchedules("cron");
          if (delayed.length === 0 && crons.length === 0) {
            console.log("No active schedules.");
            break;
          }
          for (const s of delayed) {
            const when = s.scheduledAt
              ? new Date(s.scheduledAt).toISOString()
              : "?";
            console.log(`  ${s.id.slice(0, 8)}  delayed  at ${when}`);
          }
          for (const s of crons) {
            console.log(
              `  ${s.id.slice(0, 8)}  cron     [${s.cronExpression}]`,
            );
          }
          break;
        }

        case "/cancel": {
          const prefix = args[0];
          if (!prefix) {
            console.log("Usage: /cancel <id-prefix>");
            break;
          }
          const all = [
            ...(yield* eventStore.getPendingSchedules("delayed")),
            ...(yield* eventStore.getPendingSchedules("cron")),
          ];
          const match = all.find((s) => s.id.startsWith(prefix));
          if (!match) {
            console.log(`No schedule matching '${prefix}'`);
            break;
          }
          yield* bus.cancel(match.id);
          console.log(`Canceled ${match.id.slice(0, 8)}`);
          break;
        }

        default:
          console.log(`Unknown command: ${cmd}`);
      }
      continue;
    }

    // -- Prompt ---------------------------------------------------------------

    yield* t.prompt(channelId, input);
    yield* waitWithSteering(channelId);

    console.log();
  }

  rl.close();
});

// -- Run ----------------------------------------------------------------------

Effect.provide(main, AppLayer).pipe(Effect.runPromise).catch(console.error);
