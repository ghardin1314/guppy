import {
  EventBus,
  ScheduleStore,
  makeDbLayer,
  Orchestrator,
  PiAgentFactoryLive,
  ThreadStore,
  TransportId,
  ThreadId,
  TransportMap,
  TransportRegistry,
  createBaseTools,
  type AgentThreadConfig,
} from "@guppy/core";
import { getModel } from "@mariozechner/pi-ai";
import { DateTime, Effect, Layer } from "effect";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  TerminalTransport,
  TerminalTransportLive,
} from "./terminal-transport.ts";

// -- Paths --------------------------------------------------------------------

const DB_PATH = resolve(import.meta.dir, "data.sqlite");
const WORKSPACE_DIR = resolve(import.meta.dir, "workspace");

// -- Agent config -------------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful coding agent. You can read, write, and edit files, and run shell commands.
All file paths are relative to the workspace directory.`;

const tools = createBaseTools(WORKSPACE_DIR);

const agentConfig: AgentThreadConfig = {
  model: getModel("anthropic", "claude-sonnet-4-5"),
  systemPrompt: SYSTEM_PROMPT,
  tools,
};

// -- Layers -------------------------------------------------------------------

const DbLayer = makeDbLayer(DB_PATH);
const StoreLayer = Layer.provideMerge(ThreadStore.layer, DbLayer);
const ScheduleStoreLayer = Layer.provideMerge(ScheduleStore.layer, DbLayer);
const BusLayer = Layer.provideMerge(EventBus.layer, ScheduleStoreLayer);

const RegistryLayer = TransportRegistry.layer;

const TransportMapLayer = Layer.provide(
  TransportMap.DefaultWithoutDependencies,
  RegistryLayer,
);

const OrchestratorLayer = Layer.provide(
  Orchestrator.layer(agentConfig),
  Layer.mergeAll(StoreLayer, PiAgentFactoryLive, TransportMapLayer, BusLayer),
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
const TERMINAL = TransportId.make("terminal");

const waitWithSteering = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const t = yield* TerminalTransport;
    yield* Effect.race(
      t.waitForAgentEnd,
      Effect.gen(function* () {
        while (true) {
          const line = yield* readLine("");
          if (!line) continue;
          if (line === "/stop") {
            yield* t.stop(threadId);
          } else {
            yield* t.steer(threadId, line);
          }
        }
      }),
    );
  });

// -- Main ---------------------------------------------------------------------

const main = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const t = yield* TerminalTransport;
  const orch = yield* Orchestrator;
  const scheduleStore = yield* ScheduleStore;

  let threadId = ThreadId.make("default");
  let thread = yield* store.getOrCreateThread(TERMINAL, threadId);

  console.log("Effect agent prototype ready.");
  console.log(
    "Commands: /new, /threads, /switch <id>, /followup <text>, /quit",
  );
  console.log("Schedule: /schedule <dur> <msg>, /cron <5-fields> <msg>");
  console.log("         /schedules, /cancel <id>");
  console.log("Type mid-stream to steer. /stop to abort.\n");
  console.log(`Thread: ${thread.threadId.slice(0, 8)}...\n`);

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
          threadId = ThreadId.make(crypto.randomUUID().slice(0, 8));
          thread = yield* store.getOrCreateThread(TERMINAL, threadId);
          console.log(`New thread: ${thread.threadId.slice(0, 8)}...`);
          break;
        }

        case "/threads": {
          const threads = yield* store.listThreads(TERMINAL);
          if (threads.length === 0) {
            console.log("No threads.");
            break;
          }
          for (const t of threads) {
            const count = yield* store.countMessages(t.threadId);
            const active = t.threadId === thread.threadId ? " ← current" : "";
            console.log(
              `  ${t.threadId.slice(0, 8)}  ${t.threadId}  ${count} msgs${active}`,
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
          const threads = yield* store.listThreads(TERMINAL);
          const match = threads.find((t) => t.threadId.startsWith(prefix));
          if (!match) {
            console.log(`No thread matching '${prefix}'`);
            break;
          }
          thread = match;
          threadId = thread.threadId;
          console.log(`Switched to thread: ${thread.threadId.slice(0, 8)}...`);
          break;
        }

        case "/followup": {
          const content = args.join(" ");
          if (!content) {
            console.log("Usage: /followup <text>");
            break;
          }
          yield* t.followUp(threadId, content);
          yield* waitWithSteering(threadId);
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
          const sched = yield* orch
            .scheduleMessage(TERMINAL, threadId, message, {
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
          const sched = yield* orch
            .scheduleMessage(TERMINAL, threadId, message, {
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
          const delayed = yield* scheduleStore.getPendingSchedules("delayed");
          const crons = yield* scheduleStore.getPendingSchedules("cron");
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
            ...(yield* scheduleStore.getPendingSchedules("delayed")),
            ...(yield* scheduleStore.getPendingSchedules("cron")),
          ];
          const match = all.find((s) => s.id.startsWith(prefix));
          if (!match) {
            console.log(`No schedule matching '${prefix}'`);
            break;
          }
          yield* orch.cancelSchedule(match.id);
          console.log(`Canceled ${match.id.slice(0, 8)}`);
          break;
        }

        default:
          console.log(`Unknown command: ${cmd}`);
      }
      continue;
    }

    // -- Prompt ---------------------------------------------------------------

    yield* t.prompt(threadId, input);
    yield* waitWithSteering(threadId);

    console.log();
  }

  rl.close();
});

// -- Run ----------------------------------------------------------------------

Effect.provide(main, AppLayer).pipe(Effect.runPromise).catch(console.error);
