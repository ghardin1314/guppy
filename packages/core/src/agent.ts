import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from "@mariozechner/pi-agent-core";
import { Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Model, TSchema } from "@mariozechner/pi-ai";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import { Chunk, Context, Effect, Layer, Schema, Stream } from "effect";

// -- Errors -------------------------------------------------------------------

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  message: Schema.String,
}) {}

// -- Config -------------------------------------------------------------------

export interface CreateAgentConfig<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> {
  readonly systemPrompt: string;
  readonly model: Model<any>;
  readonly tools?: AgentTool<TParameters, TDetails>[];
  readonly messages?: AgentMessage[];
}

// -- Handle (per-instance) ----------------------------------------------------

export interface AgentHandle {
  readonly prompt: (
    content: string | AgentMessage | AgentMessage[],
  ) => Effect.Effect<void, AgentError>;
  readonly steer: (message: AgentMessage) => void;
  readonly followUp: (message: AgentMessage) => void;
  readonly continue: () => Effect.Effect<void, AgentError>;
  readonly abort: () => void;
  readonly isStreaming: () => boolean;
  readonly messages: () => readonly AgentMessage[];
  /** Stream of agent events, stays open for the agent's lifetime. */
  readonly events: Stream.Stream<AgentEvent>;
}

// -- Factory service ----------------------------------------------------------

export class AgentFactory extends Context.Tag("@guppy/core/AgentFactory")<
  AgentFactory,
  {
    readonly create: (
      config: CreateAgentConfig,
    ) => Effect.Effect<AgentHandle, AgentError>;
  }
>() {}

// -- Pi implementation --------------------------------------------------------

export const PiAgentFactoryLive = Layer.succeed(AgentFactory, {
  create: (config) =>
    Effect.try({
      try: () => {
        const agent = new PiAgent({
          initialState: {
            systemPrompt: config.systemPrompt,
            model: config.model,
            tools: config.tools ?? [],
            messages: config.messages ?? [],
          },
          getApiKey: (provider: string) => getEnvApiKey(provider),
        });

        return {
          prompt: (content) =>
            Effect.tryPromise({
              try: async () => {
                if (typeof content === "string") await agent.prompt(content);
                else await agent.prompt(content);
              },
              catch: (e) => new AgentError({ message: String(e) }),
            }),
          steer: (msg) => agent.steer(msg),
          followUp: (msg) => agent.followUp(msg),
          continue: () =>
            Effect.tryPromise({
              try: async () => {
                await agent.continue();
              },
              catch: (e) => new AgentError({ message: String(e) }),
            }),
          abort: () => agent.abort(),
          isStreaming: () => agent.state.isStreaming,
          messages: () => agent.state.messages,
          events: Stream.async<AgentEvent>((emit) => {
            const unsub = agent.subscribe((event) => {
              emit(Effect.succeed(Chunk.of(event)));
            });
            return Effect.sync(unsub);
          }),
        } satisfies AgentHandle;
      },
      catch: (e) => new AgentError({ message: String(e) }),
    }),
});
