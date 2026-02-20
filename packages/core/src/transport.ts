/**
 * Transport interface and service tag.
 *
 * A transport bridges an external messaging channel (Slack, Discord, web UI)
 * into the Guppy runtime. Agent threads pull their transport via Effect DI.
 */

import { Context, Effect } from "effect";
import type { AgentResponseEvent, ThreadId } from "./schema.ts";

// -- Interface ----------------------------------------------------------------

export interface Transport {
  /** Called by the agent thread at the start of each turn.
   *  Returns channel-specific context: system prompt additions,
   *  recent channel messages, formatting instructions, etc. */
  readonly getContext: (threadId: ThreadId) => Effect.Effect<string>;

  /** Called by the agent thread for every AgentEvent.
   *  The transport decides what to do with each event type —
   *  Slack might post on agent_end only, web UI streams everything. */
  readonly deliver: (
    threadId: ThreadId,
    event: AgentResponseEvent,
  ) => Effect.Effect<void>;
}

// -- Service tag --------------------------------------------------------------

export class TransportService extends Context.Tag(
  "@guppy/core/TransportService",
)<TransportService, Transport>() {}
