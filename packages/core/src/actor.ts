import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Api, ImageContent, Model } from "@mariozechner/pi-ai";
import type { Message, SentMessage, Thread } from "chat";
import { RateLimitError } from "chat";
import {
  estimateContextTokens,
  resolveCompactionSettings,
  runCompaction,
  shouldCompact,
} from "./compaction";
import type { Store } from "./store";
import type { ActorMessage, AgentFactory, Settings } from "./types";

// -- Transport retry --

const TRANSPORT_MAX_RETRIES = 3;
const TRANSPORT_BASE_DELAY_MS = 1000;

function isTransportRetryable(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  // Network errors, 5xx from adapters
  if (err instanceof Error) {
    return /network|ECONNRESET|ETIMEDOUT|5\d{2}|service.?unavailable/i.test(
      err.message,
    );
  }
  return false;
}

function getTransportDelay(err: unknown, attempt: number): number {
  if (err instanceof RateLimitError && err.retryAfterMs) {
    return err.retryAfterMs;
  }
  return TRANSPORT_BASE_DELAY_MS * 2 ** attempt;
}

async function withTransportRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= TRANSPORT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < TRANSPORT_MAX_RETRIES && isTransportRetryable(err)) {
        const delay = getTransportDelay(err, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const CONTEXT_OVERFLOW_RE =
  /context.?length|too long|token.?limit|prompt is too long|exceeds.*context/i;

function isContextOverflow(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CONTEXT_OVERFLOW_RE.test(msg);
}

// -- Descriptive error messages --

const ERROR_PATTERNS: Array<{ test: RegExp; message: string }> = [
  {
    test: /rate.?limit|429|too many requests|quota/i,
    message: "I'm being rate-limited by my AI provider. Try again in a moment.",
  },
  {
    test: /overloaded|503|service.?unavailable|capacity/i,
    message: "My AI provider is currently overloaded. Try again in a moment.",
  },
  {
    test: /timeout|timed?\s*out|ETIMEDOUT|ECONNRESET|network|connection/i,
    message: "I lost connection to my AI provider. Try again in a moment.",
  },
  {
    test: CONTEXT_OVERFLOW_RE,
    message:
      "Our conversation is too long for me to process. Try starting a new thread.",
  },
  {
    test: /abort|cancelled|canceled/i,
    message: "My response was interrupted. Send your message again if needed.",
  },
];

export { describeError, isTransportRetryable, withTransportRetry };

function describeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const { test, message } of ERROR_PATTERNS) {
    if (test.test(raw)) return message;
  }
  return `Something went wrong: ${raw}. Try sending your message again.`;
}

// -- RunMessage: owns the single evolving chat message for one agent run --

const WORKING_INDICATOR = " \u2026";

/**
 * Manages a single evolving chat message for one agent prompt.
 * All writes go through the serialized chain — call sites never
 * touch the SentMessage handle or thread directly.
 */
class RunMessage {
  private sentMessage: SentMessage | null = null;
  private statusLines: string[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private thread: Thread,
    existingMessage?: SentMessage,
  ) {
    if (existingMessage) {
      this.sentMessage = existingMessage;
      this.statusLines.push(existingMessage.text);
    }
  }

  /** Post the initial "_Thinking_" status */
  thinking(): void {
    this.enqueue(async () => {
      this.statusLines.push("_Thinking_");
      await this.editOrPost(this.statusDisplay());
    });
  }

  /** Append a tool-start label: "_→ toolName_" */
  toolStart(toolName: string): void {
    this.enqueue(async () => {
      this.statusLines.push(`_→ ${toolName}_`);
      await this.editOrPost(this.statusDisplay());
    });
  }

  /** Append a truncated tool error line */
  toolError(text: string): void {
    const truncated = text.length > 200 ? text.slice(0, 200) + "…" : text;
    this.enqueue(async () => {
      this.statusLines.push(`_Error: ${truncated}_`);
      await this.editOrPost(this.statusDisplay());
    });
  }

  /** Replace the entire message with the final response text */
  finish(text: string): void {
    this.enqueue(async () => {
      await this.editOrPost(text);
    });
  }

  /** Delete the sent message (e.g. suppress a [SILENT] response) */
  discard(): void {
    this.enqueue(async () => {
      if (this.sentMessage) {
        await withTransportRetry(() => this.sentMessage!.delete());
        this.sentMessage = null;
      }
    });
  }

  /** Replace the entire message with an error */
  error(msg: string): void {
    this.finish(`_Error: ${msg}_`);
  }

  /** Wait for all enqueued writes to complete */
  async flush(): Promise<void> {
    await this.chain;
  }

  private statusDisplay(): string {
    return this.statusLines.join("\n") + WORKING_INDICATOR;
  }

  private async editOrPost(display: string): Promise<void> {
    if (this.sentMessage) {
      this.sentMessage = await withTransportRetry(() =>
        this.sentMessage!.edit(display),
      );
    } else {
      this.sentMessage = await withTransportRetry(() =>
        this.thread.post(display),
      );
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => {
      console.warn("[RunMessage] send failed:", err);
    });
  }
}

// -- Actor --

export interface CompactionDeps {
  model: Model<Api>;
  getApiKey: (provider: string) => string | undefined;
}

interface ActorDeps {
  store: Store;
  agentFactory: AgentFactory;
  settings: Settings;
  compaction?: CompactionDeps;
}

interface PromptItem {
  text: string;
  thread: Thread;
  message?: Message;
  sentMessage?: SentMessage;
}

const DEFAULT_MAX_QUEUE_DEPTH = 20;

export class Actor {
  readonly threadId: string;
  private queue: PromptItem[] = [];
  private agent: Agent | null = null;
  private running = false;
  private unsub: (() => void) | null = null;
  /** Current run's message handle — set during drainQueue, read by event handler */
  private runMessage: RunMessage | null = null;
  private deps: ActorDeps;

  constructor(threadId: string, deps: ActorDeps) {
    this.threadId = threadId;
    this.deps = deps;
  }

  receive(msg: ActorMessage): void {
    switch (msg.type) {
      case "prompt": {
        const maxDepth =
          this.deps.settings.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
        if (this.queue.length >= maxDepth) {
          msg.thread
            .post("Too many queued messages — please wait.")
            .catch(() => {});
          return;
        }
        this.queue.push({
          text: msg.text,
          thread: msg.thread,
          message: msg.message,
          sentMessage: msg.sentMessage,
        });
        if (!this.running) {
          this.drainQueue();
        }
        break;
      }
      case "steer":
        if (this.agent && this.running) {
          this.agent.steer({
            role: "user",
            content: msg.text,
            timestamp: Date.now(),
          });
        }
        break;
      case "abort":
        if (this.agent && this.running) {
          this.agent.abort();
        }
        break;
    }
  }

  private async drainQueue(): Promise<void> {
    this.running = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const msg = new RunMessage(item.thread, item.sentMessage);
      this.runMessage = msg;

      try {
        this.activate(item.thread);

        const context = this.deps.store.loadContext(this.threadId);
        this.agent!.replaceMessages(context);

        // Pre-prompt compaction: compact before prompting to avoid overflow
        await this.tryCompact(msg);

        // Load image and file attachments from disk
        let promptText = item.text;
        let images: ImageContent[] | undefined;

        if (item.message?.attachments?.length) {
          const att = this.deps.store.loadAttachments(
            this.threadId,
            item.message.id,
          );
          if (att.images.length > 0) images = att.images;
          if (att.filePaths.length > 0) {
            promptText += `\n\n<attachments>\n${att.filePaths.join("\n")}\n</attachments>`;
          }
        }

        try {
          await this.agent!.prompt(promptText, images);
        } catch (err) {
          // Overflow → compact and retry once
          if (isContextOverflow(err) && this.deps.compaction) {
            const didCompact = await this.tryCompact(msg, true);
            if (didCompact) {
              await this.agent!.prompt(promptText, images);
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }

        this.deps.store.saveContext(this.threadId, this.agent!.state.messages);

        const finalText = this.extractFinalText();

        if (finalText.trim() === "[SILENT]") {
          msg.discard();
        } else {
          const inspectLink = this.deps.settings.inspectUrl?.(this.threadId);
          const displayText = inspectLink
            ? `${finalText}\n\n[Inspect thread](${inspectLink})`
            : finalText;
          msg.finish(displayText);
          this.deps.store.logBotResponse(this.threadId, finalText);
        }
      } catch (err) {
        console.error(`[Actor:${this.threadId}]`, err);
        msg.error(describeError(err));
      }

      await msg.flush();
      this.runMessage = null;
    }

    this.running = false;
    // TODO: idle timeout — orchestrator should destroy actors after inactivity
  }

  // -- Event handling (single subscription per agent lifetime) --

  private activate(thread: Thread): void {
    if (!this.agent) {
      this.agent = this.deps.agentFactory(thread);
      this.unsub = this.agent.subscribe((e) => this.handleAgentEvent(e));
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    const msg = this.runMessage;
    if (!msg) return;

    switch (event.type) {
      case "agent_start":
        msg.thinking();
        break;
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "message_start":
        break;

      case "message_update":
        // TODO: consider streaming via thread.post(asyncIterable) for long responses
        break;

      case "message_end":
        // Final text extracted from agent.state.messages after prompt() resolves
        break;

      case "tool_execution_start": {
        const toolLabel =
          (event.args as { label?: string })?.label ?? event.toolName;
        msg.toolStart(toolLabel);
        break;
      }

      case "tool_execution_update":
        break;

      case "tool_execution_end":
        if (event.isError) {
          const errText =
            typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result);
          msg.toolError(errText);
        }
        // TODO: provide a way for users to inspect full tool call details
        // (e.g. a /run-log command, web dashboard, or expandable thread reply)
        break;
    }
  }

  /**
   * Run compaction if needed. Returns true if messages were compacted.
   * When `force` is true, skips the threshold check (used after overflow).
   */
  private async tryCompact(msg: RunMessage, force = false): Promise<boolean> {
    if (!this.deps.compaction || !this.agent) return false;
    try {
      const settings = resolveCompactionSettings(
        this.deps.settings,
        this.deps.compaction.model,
      );
      if (
        !force &&
        !shouldCompact(
          estimateContextTokens(this.agent.state.messages),
          settings,
        )
      ) {
        return false;
      }
      msg.toolStart("Compacting context");
      const compacted = await runCompaction(
        this.agent.state.messages,
        settings,
        this.deps.compaction.model,
        this.deps.compaction.getApiKey,
      );
      if (compacted !== this.agent.state.messages) {
        this.agent.replaceMessages(compacted);
        this.deps.store.saveContext(this.threadId, compacted);
        return true;
      }
    } catch (err) {
      console.warn(`[Actor:${this.threadId}] compaction failed:`, err);
    }
    return false;
  }

  /** Extract final assistant text from the last assistant message in agent state */
  private extractFinalText(): string {
    const messages = this.agent?.state.messages;
    if (!messages) return "_No response_";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ("role" in m && m.role === "assistant" && Array.isArray(m.content)) {
        // Surface API errors / abort that agent.prompt() doesn't throw
        if ("stopReason" in m && m.stopReason === "aborted") {
          return "_Stopped_";
        }
        if (
          "stopReason" in m &&
          m.stopReason === "error" &&
          "errorMessage" in m
        ) {
          return describeError(new Error(m.errorMessage as string));
        }
        return (
          m.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text",
            )
            .map((c) => c.text)
            .join("") || "_No response_"
        );
      }
    }
    return "_No response_";
  }

  destroy(): void {
    if (this.agent) {
      this.agent.abort();
    }
    this.unsub?.();
    this.unsub = null;
    this.queue.length = 0;
    this.agent = null;
    this.runMessage = null;
    this.running = false;
  }
}
