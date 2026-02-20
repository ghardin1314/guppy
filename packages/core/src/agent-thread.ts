/**
 * Agent thread: a virtual actor backed by AgentFactory.
 *
 * On spawn (rehydration):
 *   - Load message history from SQLite
 *   - Create agent handle via factory, seeded with loaded history
 *
 * On prompt/steer/followUp:
 *   - Pull transport context via TransportService.getContext
 *   - Dispatch to agent handle methods
 *   - On each turn_end, persist new messages to SQLite
 *
 * Event delivery:
 *   - A scoped fiber calls transport.deliver for every AgentEvent
 *
 * On stop:
 *   - agent.abort()
 *
 * On eviction:
 *   - Close the scope, discard the handle. SQLite has everything.
 */

import type { SqlError } from "@effect/sql";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@mariozechner/pi-ai";
import { Chunk, Effect, Mailbox, Scope, Stream } from "effect";
import { AgentError, AgentFactory, type CreateAgentConfig } from "./agent.ts";
import { ThreadStore } from "./repository.ts";
import { TransportService } from "./transport.ts";
import { ThreadMessage } from "./thread-message.ts";
import type { Message, ThreadId } from "./schema.ts";

// -- Config -------------------------------------------------------------------

export type AgentThreadConfig<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> = Pick<
  CreateAgentConfig<TParameters, TDetails>,
  "model" | "systemPrompt" | "tools"
>;

// -- Handle -------------------------------------------------------------------

export interface AgentThreadHandle {
  /** Send a message to this thread. Returns false if shut down. */
  readonly send: (msg: ThreadMessage) => Effect.Effect<boolean>;
  /** Stream of agent events, stays open for the thread's lifetime. */
  readonly events: Stream.Stream<AgentEvent>;
}

// -- Message conversion -------------------------------------------------------

/** Convert guppy Message rows → AgentMessage[] for rehydration. */
function rowsToAgentMessages(rows: ReadonlyArray<Message>): AgentMessage[] {
  return rows.map((row) => {
    const content = JSON.parse(row.content);
    switch (row.role) {
      case "assistant":
      case "tool_result":
        return content; // stored as full message objects
      case "user":
      case "summary":
      default:
        return { role: "user" as const, content, timestamp: row.createdAt };
    }
  });
}

// TODO: replace cast with proper type guard — tightly coupled to Pi's Message shape
/** Convert an AgentMessage → { role, content } for SQLite storage. */
function agentMessageToRow(msg: AgentMessage): {
  role: Message["role"];
  content: string;
} {
  const m = msg as import("@mariozechner/pi-ai").Message;
  switch (m.role) {
    case "assistant":
      return { role: "assistant", content: JSON.stringify(m) };
    case "toolResult":
      return { role: "tool_result", content: JSON.stringify(m) };
    case "user":
    default:
      return { role: "user", content: JSON.stringify(m.content) };
  }
}

// -- Spawn --------------------------------------------------------------------

/**
 * Spawn an agent thread. Rehydrates from SQLite, creates an agent handle
 * via factory, and starts a processing fiber. Scoped — closing the scope evicts.
 *
 * Requires TransportService to be provided (typically via TransportMap.get).
 */
export const spawn = (
  config: AgentThreadConfig,
  threadId: ThreadId,
): Effect.Effect<
  AgentThreadHandle,
  SqlError.SqlError | AgentError,
  AgentFactory | ThreadStore | TransportService | Scope.Scope
> =>
  Effect.gen(function* () {
    const factory = yield* AgentFactory;
    const store = yield* ThreadStore;
    const transport = yield* TransportService;
    const inbox = yield* Mailbox.make<ThreadMessage>();

    // -- Rehydrate: load context, create agent handle ---------------------------

    const context = yield* store.getContext(threadId);
    const history = rowsToAgentMessages(context);

    const agent = yield* factory.create({
      systemPrompt: config.systemPrompt,
      model: config.model,
      tools: config.tools,
      messages: history,
    });

    // -- Persistence on turn_end ------------------------------------------------

    let persistedCount = history.length;

    yield* agent.events.pipe(
      Stream.filter((e) => e.type === "turn_end"),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const allMessages = agent.messages();
          const newMessages = allMessages.slice(persistedCount);
          if (newMessages.length === 0) return;
          for (const msg of newMessages) {
            const { role, content } = agentMessageToRow(msg);
            const thread = yield* store.getThread(threadId);
            const parentId = thread?.leafId ?? null;
            yield* store.insertMessage(threadId, parentId, role, content);
          }
          persistedCount = allMessages.length;
        }),
      ),
      Effect.forkScoped,
    );

    // -- Transport delivery fiber -----------------------------------------------

    yield* agent.events.pipe(
      Stream.runForEach((event) => transport.deliver(threadId, event)),
      Effect.forkScoped,
    );

    // -- Processing loop --------------------------------------------------------

    const loop = Effect.gen(function* () {
      while (true) {
        const [messages, done] = yield* inbox.takeAll;
        if (done) break;
        if (Chunk.isEmpty(messages)) continue;

        for (const msg of messages) {
          yield* ThreadMessage.$match(msg, {
            Prompt: ({ content }) =>
              Effect.gen(function* () {
                const ctx = yield* transport.getContext(threadId);
                const enriched = ctx
                  ? `${ctx}\n\n---\n${content}`
                  : content;
                yield* agent.prompt(enriched);
              }),
            FollowUp: ({ content }) =>
              Effect.gen(function* () {
                agent.followUp({
                  role: "user",
                  content,
                  timestamp: Date.now(),
                });
                if (!agent.isStreaming()) {
                  yield* agent.continue();
                }
              }),
            Steering: ({ content }) =>
              Effect.gen(function* () {
                if (agent.isStreaming()) {
                  agent.steer({
                    role: "user",
                    content,
                    timestamp: Date.now(),
                  });
                } else {
                  yield* agent.prompt(content);
                }
              }),
            Stop: () => Effect.sync(() => agent.abort()),
          });
        }
      }
    });

    yield* Effect.forkScoped(loop);

    // -- Handle -----------------------------------------------------------------

    const send = (msg: ThreadMessage): Effect.Effect<boolean> => {
      if (msg._tag === "Stop") {
        return Effect.sync(() => {
          if (agent.isStreaming()) {
            agent.abort();
            return true;
          }
          return false;
        });
      }
      if (msg._tag === "Steering" && agent.isStreaming()) {
        return Effect.sync(() => {
          agent.steer({
            role: "user",
            content: msg.content,
            timestamp: Date.now(),
          });
          return true;
        });
      }
      return inbox.offer(msg);
    };

    return { send, events: agent.events } satisfies AgentThreadHandle;
  });
