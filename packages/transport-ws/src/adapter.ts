/**
 * WsTransportAdapter: plain-TS facade over the WebsocketTransport Effect service.
 *
 * Extracts and runs effects through a booted Guppy runtime, so callers
 * never touch Effect types directly.
 */

import { Effect } from "effect";
import type { Guppy } from "@guppy/core";
import type { ThreadId } from "@guppy/core";
import { ThreadMessage } from "@guppy/core";
import { WebsocketTransport } from "./ws-transport.ts";

export class WsTransportAdapter {
  constructor(
    private readonly guppy: Guppy<WebsocketTransport>,
  ) {}

  private run<A>(effect: Effect.Effect<A, unknown, WebsocketTransport>) {
    return this.guppy.runEffect(effect);
  }

  connect(channelId: string, client: { send(data: string): void }) {
    return this.run(
      Effect.flatMap(WebsocketTransport, (ws) =>
        ws.connect(channelId, client),
      ),
    );
  }

  disconnect(channelId: string) {
    return this.run(
      Effect.flatMap(WebsocketTransport, (ws) => ws.disconnect(channelId)),
    );
  }

  handleMessage(channelId: string, raw: string) {
    return this.run(
      Effect.flatMap(WebsocketTransport, (ws) =>
        ws.handleMessage(channelId, raw),
      ),
    );
  }

  subscribe(channelId: string, threadId: ThreadId) {
    return this.run(
      Effect.flatMap(WebsocketTransport, (ws) =>
        ws.subscribe(channelId, threadId),
      ),
    );
  }

  unsubscribe(channelId: string, threadId: ThreadId) {
    return this.run(
      Effect.flatMap(WebsocketTransport, (ws) =>
        ws.unsubscribe(channelId, threadId),
      ),
    );
  }

  send(threadId: ThreadId, msg: ThreadMessage) {
    return this.run(
      Effect.flatMap(WebsocketTransport, (ws) => ws.send(threadId, msg)),
    );
  }
}
