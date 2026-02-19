/**
 * Transport interface and service tag.
 *
 * A transport bridges an external messaging channel (Slack, Discord, web UI)
 * into the Guppy runtime. Agent threads pull their transport via Effect DI.
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Context, Effect } from "effect";

// -- Interface ----------------------------------------------------------------

export interface Transport {
  /** Called by the agent thread at the start of each turn.
   *  Returns channel-specific context: system prompt additions,
   *  recent channel messages, formatting instructions, etc. */
  readonly getContext: (threadId: string) => Effect.Effect<string>;

  /** Called by the agent thread for every AgentEvent.
   *  The transport decides what to do with each event type —
   *  Slack might post on agent_end only, web UI streams everything. */
  readonly deliver: (
    threadId: string,
    event: AgentEvent,
  ) => Effect.Effect<void>;
}

// -- Service tag --------------------------------------------------------------

export class TransportService extends Context.Tag(
  "@guppy/core/TransportService",
)<TransportService, Transport>() {}
