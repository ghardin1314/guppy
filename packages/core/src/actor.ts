import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";
import type { SentMessage, Thread } from "chat";
import type { Store } from "./store";
import type { ActorMessage, AgentFactory, Settings } from "./types";

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

  constructor(private thread: Thread) {}

  /** Post the initial "_Thinking_" status */
  thinking(): void {
    this.enqueue(async () => {
      this.statusLines.push("_Thinking_");
      this.sentMessage = await this.thread.post(
        this.statusDisplay()
      );
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
      this.sentMessage = await this.sentMessage.edit(display);
    } else {
      this.sentMessage = await this.thread.post(display);
    }
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => {
      console.warn("[RunMessage] send failed:", err);
    });
  }
}

// -- Actor --

interface ActorDeps {
  store: Store;
  agentFactory: AgentFactory;
  settings: Settings;
}

interface PromptItem {
  text: string;
  thread: Thread;
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
        this.queue.push({ text: msg.text, thread: msg.thread });
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
      const msg = new RunMessage(item.thread);
      this.runMessage = msg;

      try {
        this.activate();

        const context = this.deps.store.loadContext(this.threadId);
        this.agent!.replaceMessages(context);

        await this.agent!.prompt(item.text);
        this.deps.store.saveContext(this.threadId, this.agent!.state.messages);
        msg.finish(this.extractFinalText());
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : "Unknown error occurred";
        msg.error(errMsg);
      }

      await msg.flush();
      this.runMessage = null;
    }

    this.running = false;
    // TODO: idle timeout — orchestrator should destroy actors after inactivity
  }

  // -- Event handling (single subscription per agent lifetime) --

  private activate(): void {
    if (!this.agent) {
      this.agent = this.deps.agentFactory(this.threadId);
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

      case "tool_execution_start":
        msg.toolStart(event.toolName);
        break;

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

  /** Extract final assistant text from the last assistant message in agent state */
  private extractFinalText(): string {
    const messages = this.agent?.state.messages;
    if (!messages) return "_No response_";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ("role" in m && m.role === "assistant" && Array.isArray(m.content)) {
        return (
          m.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text"
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
