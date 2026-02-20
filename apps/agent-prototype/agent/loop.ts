import type { Database } from "bun:sqlite";
import { agentLoop } from "@mariozechner/pi-agent-core";
import type { AgentMessage, AgentEvent, AgentContext, AgentLoopConfig } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { createBaseTools } from "@guppy/core";
import { getContext, insertMessage } from "../db/messages.ts";
import { getThread, updateThreadLeaf } from "../db/threads.ts";
import { rowsToAgentMessages, agentMessageToRow, convertToLlm } from "./convert.ts";

const SYSTEM_PROMPT = `You are a helpful coding agent. You can read, write, and edit files, and run shell commands.
All file paths are relative to the workspace directory.`;

interface RunAgentOptions {
  db: Database;
  threadId: string;
  userInput: string;
  workspaceDir: string;
  model?: Model<any>;
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * Run one agent turn: load context, call agentLoop, stream events, persist results.
 */
export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const { db, threadId, userInput, workspaceDir, signal, onEvent } = opts;

  const model = opts.model ?? getModel("anthropic", "claude-sonnet-4-5");
  const tools = createBaseTools(workspaceDir);

  // Load existing context from SQLite
  const thread = getThread(db, threadId);
  if (!thread) throw new Error(`Thread ${threadId} not found`);

  let history: AgentMessage[] = [];
  if (thread.leaf_id) {
    const rows = getContext(db, thread.leaf_id);
    history = rowsToAgentMessages(rows);
  }

  // Persist user message
  const userMsg = insertMessage(db, threadId, thread.leaf_id, "user", userInput);

  // Build the user prompt as AgentMessage
  const userPrompt: AgentMessage = {
    role: "user",
    content: userInput,
    timestamp: Date.now(),
  };

  const context: AgentContext = {
    systemPrompt: SYSTEM_PROMPT,
    messages: history,
    tools,
  };

  const config: AgentLoopConfig = {
    model,
    convertToLlm,
    getApiKey: (provider: string) => getEnvApiKey(provider),
  };

  // Run the loop
  const stream = agentLoop([userPrompt], context, config, signal);

  for await (const event of stream) {
    onEvent?.(event);
  }

  // Get final messages (all new messages produced by the loop)
  const allMessages = await stream.result();

  // Persist new messages (skip the ones already in history + the user prompt we already saved)
  // The result includes all context messages + new ones. New ones start after history.length + 1 (user prompt)
  const newMessages = allMessages.slice(history.length + 1);
  let leafId = userMsg.id;

  for (const msg of newMessages) {
    const { role, content } = agentMessageToRow(msg);
    const row = insertMessage(db, threadId, leafId, role, content);
    leafId = row.id;
  }
}
