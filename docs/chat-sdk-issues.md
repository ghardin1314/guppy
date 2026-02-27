# Chat SDK — upstream issues to file

## 1. Discord reaction events missing thread context

**Adapter:** `@chat-adapter/discord`
**Location:** `handleGatewayReaction` + `handleForwardedReaction`

Both handlers pass `threadId: undefined` when calling `encodeThreadId`, producing a 3-segment channel-level ID (`discord:{guildId}:{channelId}`) even when the reaction is on a message inside a thread.

**Exact locations** (`packages/adapter-discord/src/index.ts`):
- **Line 547–550** — `handleForwardedReaction` (webhook path): passes `channelId` with no `threadId`
- **Line 1664–1670** — `handleGatewayReaction` (gateway path): explicitly passes `threadId: undefined`, comment says "we don't know if the message is in a thread without fetching it"

**Fix exists in same file** — `handleGatewayMessage` (lines 1555–1568) already resolves thread context:
```ts
const isInThread = message.channel.isThread();
let parentChannelId = channelId;
if (isInThread && "parentId" in message.channel && message.channel.parentId) {
  discordThreadId = channelId;
  parentChannelId = message.channel.parentId;
}
```
Same logic should apply to reactions. The gateway `reaction.message.channel` object should expose `isThread()` and `parentId`.

**Impact:** `event.threadId` from `onReaction` is a 3-segment channel-level ID instead of the correct 4-segment thread ID. Any feature keyed on `threadId` (abort-by-reaction, per-thread state) gets a wrong key for reactions in threads.
