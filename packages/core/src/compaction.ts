/**
 * Context compaction for long threads.
 *
 * When context tokens exceed threshold, summarize old messages into a
 * structured checkpoint and keep recent messages verbatim.
 * Ported from pi-mono's coding-agent compaction, simplified for
 * guppy's flat AgentMessage[] model.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";

// ============================================================================
// Settings
// ============================================================================

export interface CompactionSettings {
  enabled: boolean;
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

const DEFAULTS = {
  reserveTokens: 16384,
  keepRecentTokens: 20000,
} as const;

/** Merge user settings with model defaults. */
export function resolveCompactionSettings(
  settings: {
    compaction?: {
      enabled?: boolean;
      contextWindow?: number;
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  },
  model: Model<Api>,
): CompactionSettings {
  const c = settings.compaction ?? {};
  return {
    enabled: c.enabled !== false,
    contextWindow: c.contextWindow ?? model.contextWindow,
    reserveTokens: c.reserveTokens ?? DEFAULTS.reserveTokens,
    keepRecentTokens: c.keepRecentTokens ?? DEFAULTS.keepRecentTokens,
  };
}

// ============================================================================
// Token estimation
// ============================================================================

/** Estimate token count for a single message (chars/4 heuristic). */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;

  if (!("role" in message)) return 0;

  switch (message.role) {
    case "user": {
      const content = (message as UserMessage).content;
      if (typeof content === "string") {
        chars = content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && "text" in block) {
            chars += (block as { text: string }).text.length;
          }
        }
      }
      return Math.ceil(chars / 4);
    }
    case "assistant": {
      const assistant = message as AssistantMessage;
      for (const block of assistant.content) {
        if (block.type === "text") {
          chars += block.text.length;
        } else if (block.type === "thinking") {
          chars += block.thinking.length;
        } else if (block.type === "toolCall") {
          chars += block.name.length + JSON.stringify(block.arguments).length;
        }
      }
      return Math.ceil(chars / 4);
    }
    case "toolResult": {
      for (const block of message.content) {
        if (block.type === "text" && "text" in block) {
          chars += (block as { text: string }).text.length;
        }
        if (block.type === "image") {
          chars += 4800;
        }
      }
      return Math.ceil(chars / 4);
    }
  }
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (!("role" in msg) || msg.role !== "assistant") return undefined;
  const a = msg as AssistantMessage;
  if (a.stopReason === "aborted" || a.stopReason === "error") return undefined;
  return a.usage ?? undefined;
}

function calculateContextTokens(usage: Usage): number {
  return (
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

/**
 * Estimate total context tokens.
 * Uses last assistant's Usage.totalTokens when available, chars/4 for trailing.
 */
export function estimateContextTokens(messages: AgentMessage[]): number {
  // Find last assistant message with usage
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) {
      let trailing = 0;
      for (let j = i + 1; j < messages.length; j++) {
        trailing += estimateTokens(messages[j]);
      }
      return calculateContextTokens(usage) + trailing;
    }
  }

  // No usage — estimate everything
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg);
  }
  return total;
}

/** Check if compaction should trigger. */
export function shouldCompact(
  contextTokens: number,
  settings: CompactionSettings,
): boolean {
  if (!settings.enabled) return false;
  return contextTokens > settings.contextWindow - settings.reserveTokens;
}

// ============================================================================
// Cut point detection
// ============================================================================

export interface CutPointResult {
  /** Index of first message to keep */
  firstKeptIndex: number;
  /** Whether this cut splits a turn (assistant without preceding user) */
  isSplitTurn: boolean;
  /** Index of the user message that starts the split turn, or -1 */
  turnStartIndex: number;
}

/**
 * Find the cut point that keeps approximately keepRecentTokens.
 * Walk backwards accumulating tokens. Cut at user or assistant boundary
 * (never toolResult).
 */
export function findCutPoint(
  messages: AgentMessage[],
  keepRecentTokens: number,
): CutPointResult {
  const noOp: CutPointResult = {
    firstKeptIndex: 0,
    isSplitTurn: false,
    turnStartIndex: -1,
  };

  if (messages.length === 0) return noOp;

  // Walk backwards accumulating tokens
  let accumulated = 0;
  let cutIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    accumulated += estimateTokens(messages[i]);
    if (accumulated >= keepRecentTokens) {
      // Find nearest valid cut point at or after i
      cutIndex = findNearestValidCut(messages, i);
      break;
    }
  }

  // All messages fit within budget
  if (accumulated < keepRecentTokens) return noOp;

  // Determine if we're splitting a turn
  const cutMsg = messages[cutIndex];
  const isUserMsg = "role" in cutMsg && cutMsg.role === "user";

  if (isUserMsg) {
    return { firstKeptIndex: cutIndex, isSplitTurn: false, turnStartIndex: -1 };
  }

  // Find the user message that started this turn
  const turnStart = findTurnStart(messages, cutIndex);

  return {
    firstKeptIndex: cutIndex,
    isSplitTurn: turnStart !== -1 && turnStart < cutIndex,
    turnStartIndex: turnStart,
  };
}

/** Find nearest valid cut point (user or assistant, never toolResult) at or after index. */
function findNearestValidCut(messages: AgentMessage[], from: number): number {
  for (let i = from; i < messages.length; i++) {
    const msg = messages[i];
    if ("role" in msg && (msg.role === "user" || msg.role === "assistant")) {
      return i;
    }
  }
  // Fallback: keep everything from `from`
  return from;
}

/** Walk backwards from index to find the user message that starts this turn. */
function findTurnStart(messages: AgentMessage[], index: number): number {
  for (let i = index; i >= 0; i--) {
    if ("role" in messages[i] && messages[i].role === "user") {
      return i;
    }
  }
  return -1;
}

// ============================================================================
// File operation tracking
// ============================================================================

interface FileOps {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

function createFileOps(): FileOps {
  return { read: new Set(), written: new Set(), edited: new Set() };
}

function extractFileOpsFromMessage(msg: AgentMessage, ops: FileOps): void {
  if (!("role" in msg) || msg.role !== "assistant") return;
  const assistant = msg as AssistantMessage;
  for (const block of assistant.content) {
    if (block.type !== "toolCall") continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    if (!path) continue;
    switch (block.name) {
      case "read":
        ops.read.add(path);
        break;
      case "write":
        ops.written.add(path);
        break;
      case "edit":
        ops.edited.add(path);
        break;
    }
  }
}

/** Parse file lists from previous compaction summary. */
function parseFileListsFromSummary(summary: string): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];

  const readMatch = summary.match(
    /<read-files>\n([\s\S]*?)\n<\/read-files>/,
  );
  if (readMatch) {
    readFiles.push(
      ...readMatch[1].split("\n").filter((l) => l.trim().length > 0),
    );
  }

  const modMatch = summary.match(
    /<modified-files>\n([\s\S]*?)\n<\/modified-files>/,
  );
  if (modMatch) {
    modifiedFiles.push(
      ...modMatch[1].split("\n").filter((l) => l.trim().length > 0),
    );
  }

  return { readFiles, modifiedFiles };
}

function computeFileLists(ops: FileOps): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...ops.edited, ...ops.written]);
  const readOnly = [...ops.read].filter((f) => !modified.has(f)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

function formatFileOperations(
  readFiles: string[],
  modifiedFiles: string[],
): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`,
    );
  }
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Serialization
// ============================================================================

/** Serialize AgentMessage[] to text for the summarization LLM. */
export function serializeConversation(messages: AgentMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (!("role" in msg)) continue;

    if (msg.role === "user") {
      const user = msg as UserMessage;
      const text =
        typeof user.content === "string"
          ? user.content
          : user.content
              .filter(
                (c): c is { type: "text"; text: string } => c.type === "text",
              )
              .map((c) => c.text)
              .join("");
      if (text) parts.push(`[User]: ${text}`);
    } else if (msg.role === "assistant") {
      const assistant = msg as AssistantMessage;
      const textParts: string[] = [];
      const toolCalls: string[] = [];

      for (const block of assistant.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }

      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const content = msg.content
        .filter(
          (c): c is { type: "text"; text: string } => c.type === "text",
        )
        .map((c) => c.text)
        .join("");
      if (content) parts.push(`[Tool result]: ${content}`);
    }
  }

  return parts.join("\n\n");
}

// ============================================================================
// Summarization prompts
// ============================================================================

const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// ============================================================================
// Summarization
// ============================================================================

async function generateSummary(
  messagesToSummarize: AgentMessage[],
  model: Model<Api>,
  apiKey: string,
  reserveTokens: number,
  previousSummary?: string,
): Promise<string> {
  const maxTokens = Math.floor(0.8 * reserveTokens);

  const conversationText = serializeConversation(messagesToSummarize);

  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
    promptText += UPDATE_SUMMARIZATION_PROMPT;
  } else {
    promptText += SUMMARIZATION_PROMPT;
  }

  const response = await completeSimple(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: promptText }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens, apiKey },
  );

  if (response.stopReason === "error") {
    throw new Error(
      `Summarization failed: ${response.errorMessage || "Unknown error"}`,
    );
  }

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  model: Model<Api>,
  apiKey: string,
  reserveTokens: number,
): Promise<string> {
  const maxTokens = Math.floor(0.5 * reserveTokens);
  const conversationText = serializeConversation(messages);
  const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_PROMPT}`;

  const response = await completeSimple(
    model,
    {
      systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: promptText }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens, apiKey },
  );

  if (response.stopReason === "error") {
    throw new Error(
      `Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
    );
  }

  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Run compaction on a message array if needed.
 * Returns the original array unchanged if no compaction needed,
 * or a new array with [summaryMessage, ...recentMessages].
 */
export async function runCompaction(
  messages: AgentMessage[],
  settings: CompactionSettings,
  model: Model<Api>,
  getApiKey: (provider: string) => string | undefined,
): Promise<AgentMessage[]> {
  if (!settings.enabled || messages.length === 0) return messages;

  const contextTokens = estimateContextTokens(messages);
  if (!shouldCompact(contextTokens, settings)) return messages;

  // Resolve API key
  const providerSlug =
    typeof model.provider === "string"
      ? model.provider
      : (model.provider as { slug: string }).slug;
  const apiKey = getApiKey(providerSlug);
  if (!apiKey) {
    console.warn("[compaction] no API key available, skipping");
    return messages;
  }

  // Detect previous compaction summary
  let previousSummary: string | undefined;
  const firstMsg = messages[0];
  if (
    "role" in firstMsg &&
    firstMsg.role === "user" &&
    typeof (firstMsg as UserMessage).content === "string" &&
    ((firstMsg as UserMessage).content as string).includes(
      "<compaction-summary>",
    )
  ) {
    previousSummary = (firstMsg as UserMessage).content as string;
    // Strip XML wrapper for the update prompt
    const inner = previousSummary.match(
      /<compaction-summary>([\s\S]*)<\/compaction-summary>/,
    );
    if (inner) previousSummary = inner[1].trim();
  }

  // Find cut point
  const cut = findCutPoint(messages, settings.keepRecentTokens);
  if (cut.firstKeptIndex === 0) return messages;

  // Determine what to summarize
  const historyEnd = cut.isSplitTurn
    ? cut.turnStartIndex
    : cut.firstKeptIndex;

  // Skip the previous compaction summary message from summarization input
  const summarizeStart = previousSummary ? 1 : 0;
  const messagesToSummarize = messages.slice(summarizeStart, historyEnd);
  const turnPrefixMessages = cut.isSplitTurn
    ? messages.slice(cut.turnStartIndex, cut.firstKeptIndex)
    : [];
  const keptMessages = messages.slice(cut.firstKeptIndex);

  // Collect file operations
  const fileOps = createFileOps();

  // Seed from previous compaction summary
  if (previousSummary) {
    const prev = parseFileListsFromSummary(previousSummary);
    for (const f of prev.readFiles) fileOps.read.add(f);
    for (const f of prev.modifiedFiles) {
      fileOps.edited.add(f);
    }
  }

  // Extract from messages being summarized + turn prefix
  for (const msg of messagesToSummarize) extractFileOpsFromMessage(msg, fileOps);
  for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);

  // Generate summary
  let summary: string;

  if (cut.isSplitTurn && turnPrefixMessages.length > 0) {
    const [historyResult, turnPrefixResult] = await Promise.all([
      messagesToSummarize.length > 0
        ? generateSummary(
            messagesToSummarize,
            model,
            apiKey,
            settings.reserveTokens,
            previousSummary,
          )
        : Promise.resolve("No prior history."),
      generateTurnPrefixSummary(
        turnPrefixMessages,
        model,
        apiKey,
        settings.reserveTokens,
      ),
    ]);
    summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
  } else {
    summary = await generateSummary(
      messagesToSummarize,
      model,
      apiKey,
      settings.reserveTokens,
      previousSummary,
    );
  }

  // Append file lists
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  // Build summary message
  const summaryMessage: UserMessage = {
    role: "user",
    content: `<compaction-summary>\n${summary}\n</compaction-summary>`,
    timestamp: Date.now(),
  };

  return [summaryMessage, ...keptMessages];
}
