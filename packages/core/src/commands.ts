import type { ActorMessage } from "./types";

export interface SlashCommandDef {
  name: string;
  description: string;
}

// TODO: file chat-sdk issue — SlashCommandEvent is channel-scoped, so /stop
// broadcasts to all actors in the channel. Thread-scoped slash commands
// (e.g. Slack's thread_ts) would let us target a single actor.

/** Built-in commands that map to ActorMessage types. */
export const BUILT_IN_COMMANDS: SlashCommandDef[] = [
  { name: "stop", description: "Stop the current agent run" },
];

/**
 * Parse a text message for a `/command args` pattern.
 * Returns null if the text isn't a slash command.
 */
export function parseCommand(
  text: string,
): { command: string; args: string } | null {
  const match = text.trimStart().match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { command: match[1], args: match[2]?.trim() ?? "" };
}

/**
 * Map a command name + args to an ActorMessage.
 * Returns null for unknown commands or invalid args.
 */
export function commandToMessage(
  command: string,
  args: string,
): ActorMessage | null {
  const name = command.startsWith("/") ? command.slice(1) : command;
  switch (name) {
    case "stop":
      return { type: "abort" };
    default:
      return null;
  }
}
