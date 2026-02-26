import { join } from "node:path";

const UNSAFE = /[/\\:*?"<>|%]/g;

export function encode(segment: string): string {
  return segment.replace(
    UNSAFE,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

export function decode(encoded: string): string {
  return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

export type ChannelKey = string & { readonly __brand: "ChannelKey" };
export type ThreadKey = string & { readonly __brand: "ThreadKey" };

export interface ThreadKeys {
  adapter: string;
  channelKey: ChannelKey;
  threadKey: ThreadKey;
}

/** Extract adapter name from the first colon-separated segment of a composite thread ID. */
export function adapterNameFrom(compositeId: string): string {
  const idx = compositeId.indexOf(":");
  if (idx === -1)
    throw new Error(`Invalid thread ID "${compositeId}": no colon found`);
  return compositeId.slice(0, idx);
}

/**
 * Resolve a composite thread ID into its parts using the Chat SDK adapter's
 * channelIdFromThreadId (handles Discord 4-segment IDs, etc.).
 */
export function resolveThreadKeys(
  adapter: { name: string; channelIdFromThreadId?(threadId: string): string },
  compositeId: string,
): ThreadKeys {
  const fullChannelId = adapter.channelIdFromThreadId
    ? adapter.channelIdFromThreadId(compositeId)
    : compositeId.split(":").slice(0, 2).join(":");

  // Strip "adapter:" prefix — channelKey for directory layout is unprefixed
  const prefix = adapter.name + ":";
  const channelKey = fullChannelId.startsWith(prefix)
    ? fullChannelId.slice(prefix.length)
    : fullChannelId;

  // threadKey = everything after the full (prefixed) channelId + ":"
  const threadKey = compositeId.slice(fullChannelId.length + 1);

  return {
    adapter: adapter.name,
    channelKey: channelKey as ChannelKey,
    threadKey: threadKey as ThreadKey,
  };
}

// -- Typesafe directory helpers --

export function transportDir(dataDir: string, adapter: string): string {
  return join(dataDir, adapter);
}

export function channelDir(
  dataDir: string,
  adapter: string,
  channelKey: ChannelKey,
): string {
  return join(dataDir, adapter, encode(channelKey));
}

export function threadDir(
  dataDir: string,
  adapter: string,
  channelKey: ChannelKey,
  threadKey: ThreadKey,
): string {
  return join(dataDir, adapter, encode(channelKey), encode(threadKey));
}
