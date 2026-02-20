/**
 * SseTransportAdapter: plain-TS facade over the SseTransport Effect service.
 *
 * Extracts and runs effects through a booted Guppy runtime, so callers
 * never touch Effect types directly.
 */

import { Effect } from "effect";
import type { Guppy } from "@guppy/core";
import { ThreadId, ThreadMessage } from "@guppy/core";
import { SseTransport } from "./sse-transport.ts";

export class SseTransportAdapter {
  constructor(private readonly guppy: Guppy<SseTransport>) {}

  private run<A>(effect: Effect.Effect<A, unknown, SseTransport>) {
    return this.guppy.runEffect(effect);
  }

  addListener(threadId: string, send: (data: string) => void) {
    return this.run(
      Effect.flatMap(SseTransport, (sse) =>
        sse.addListener(ThreadId.make(threadId), send),
      ),
    );
  }

  removeListener(threadId: string, send: (data: string) => void) {
    return this.run(
      Effect.flatMap(SseTransport, (sse) =>
        sse.removeListener(ThreadId.make(threadId), send),
      ),
    );
  }

  prompt(threadId: string, content: string) {
    return this.run(
      Effect.flatMap(SseTransport, (sse) =>
        sse.send(ThreadId.make(threadId), ThreadMessage.Prompt({ content })),
      ),
    );
  }

  stop(threadId: string) {
    return this.run(
      Effect.flatMap(SseTransport, (sse) =>
        sse.send(ThreadId.make(threadId), ThreadMessage.Stop()),
      ),
    );
  }

  steer(threadId: string, content: string) {
    return this.run(
      Effect.flatMap(SseTransport, (sse) =>
        sse.send(
          ThreadId.make(threadId),
          ThreadMessage.Steering({ content }),
        ),
      ),
    );
  }
}
