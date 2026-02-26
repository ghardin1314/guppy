import { ThreadImpl, deriveChannelId } from "chat";
import type { ChatHandle } from "./types";

/** Resolve a composite thread ID into a Thread instance. */
export function resolveThread(chat: ChatHandle, threadId: string): ThreadImpl {
  const adapterName = threadId.split(":")[0];
  const adapter = chat.getAdapter(adapterName);
  return new ThreadImpl({
    adapter,
    id: threadId,
    channelId: deriveChannelId(adapter, threadId),
    stateAdapter: chat.getState(),
    isDM: false,
  });
}
