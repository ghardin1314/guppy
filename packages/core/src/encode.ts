const UNSAFE = /[/\\:*?"<>|%]/g;

export function encode(segment: string): string {
  return segment.replace(UNSAFE, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export function decode(encoded: string): string {
  return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

export interface ThreadIdParts {
  adapter: string;
  channelId: string;
  threadId: string;
}

/** Split composite thread ID on first two colons (third segment may contain colons). */
export function parseThreadId(composite: string): ThreadIdParts {
  const first = composite.indexOf(":");
  if (first === -1)
    throw new Error(
      `Invalid thread ID "${composite}": expected format "adapter:channel:thread" but found no colons`
    );
  const second = composite.indexOf(":", first + 1);
  if (second === -1)
    throw new Error(
      `Invalid thread ID "${composite}": expected format "adapter:channel:thread" but found only one colon`
    );
  return {
    adapter: composite.slice(0, first),
    channelId: composite.slice(first + 1, second),
    threadId: composite.slice(second + 1),
  };
}
