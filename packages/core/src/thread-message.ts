/**
 * Typed messages for agent thread mailboxes.
 */

import { Data } from "effect";

// -- Inbound messages (sent to thread mailbox) --------------------------------

export type ThreadMessage = Data.TaggedEnum<{
  /** New user/external message. Triggers LLM call. */
  Prompt: { readonly content: string };
  /** Interrupt mid-run, inject new context, re-evaluate. */
  Steering: { readonly content: string };
  /** Queue after current run finishes. */
  FollowUp: { readonly content: string };
  /** Abort active LLM call immediately. */
  Stop: {};
}>;

export const ThreadMessage = Data.taggedEnum<ThreadMessage>();
