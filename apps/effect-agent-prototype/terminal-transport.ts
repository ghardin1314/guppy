/**
 * TerminalTransport: Effect service that registers a "terminal" transport
 * and exposes messaging + completion helpers.
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Context, Effect, Layer } from "effect";
import {
  Orchestrator,
  TransportRegistry,
  ThreadMessage,
  type OrchestratorService,
  type Transport,
} from "@guppy/core";

// -- Service interface --------------------------------------------------------

type SendError = Effect.Effect.Error<
  ReturnType<OrchestratorService["send"]>
>;

export interface TerminalTransportService {
  readonly prompt: (
    channelId: string,
    content: string,
  ) => Effect.Effect<void, SendError>;
  readonly steer: (
    channelId: string,
    content: string,
  ) => Effect.Effect<void, SendError>;
  readonly followUp: (
    channelId: string,
    content: string,
  ) => Effect.Effect<void, SendError>;
  readonly stop: (channelId: string) => Effect.Effect<void, SendError>;
  /** Blocks until the next `agent_end` event is delivered. */
  readonly waitForAgentEnd: Effect.Effect<void>;
}

// -- Tag ----------------------------------------------------------------------

export class TerminalTransport extends Context.Tag(
  "app/TerminalTransport",
)<TerminalTransport, TerminalTransportService>() {}

// -- Live implementation ------------------------------------------------------

export const TerminalTransportLive: Layer.Layer<
  TerminalTransport,
  never,
  Orchestrator | TransportRegistry
> = Layer.effect(
  TerminalTransport,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const registry = yield* TransportRegistry;

    // -- Completion signal ----------------------------------------------------

    let resolveEnd: (() => void) | null = null;

    const waitForAgentEnd: Effect.Effect<void> = Effect.async((resume) => {
      resolveEnd = () => resume(Effect.void);
    });

    // -- Rendering ------------------------------------------------------------

    let streamingText = false;

    const renderEvent = (event: AgentEvent): void => {
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
        case "agent_end":
          resolveEnd?.();
          resolveEnd = null;
          break;
      }
    };

    // -- Register transport ---------------------------------------------------

    const transport: Transport = {
      getContext: () => Effect.succeed(""),
      deliver: (_threadId, event) => Effect.sync(() => renderEvent(event)),
    };

    yield* registry.register("terminal", transport);

    // -- Send helper ----------------------------------------------------------

    const send = (channelId: string, msg: ThreadMessage) =>
      orchestrator.send("terminal", channelId, msg);

    // -- Service --------------------------------------------------------------

    return TerminalTransport.of({
      prompt: (channelId, content) =>
        send(channelId, ThreadMessage.Prompt({ content })),
      steer: (channelId, content) =>
        send(channelId, ThreadMessage.Steering({ content })),
      followUp: (channelId, content) =>
        send(channelId, ThreadMessage.FollowUp({ content })),
      stop: (channelId) => send(channelId, ThreadMessage.Stop()),
      waitForAgentEnd,
    });
  }),
);
