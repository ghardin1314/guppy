import {
  type AgentFactory,
  type Sandbox,
  type Settings,
  type ThreadMeta,
  buildSystemPrompt,
  buildTools,
  formatMemory,
  loadIdentity,
  loadSkills,
  resolveThreadKeys,
} from "@guppy/core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";

interface AgentFactoryDeps {
  dataDir: string;
  sandbox: Sandbox;
  settings: Settings;
  model: Model<Api>;
}

export function createAgentFactory(deps: AgentFactoryDeps): AgentFactory {
  const { dataDir, sandbox, settings, model } = deps;

  return (thread) => {
    const { adapter, channelKey, threadKey } = resolveThreadKeys(thread.adapter, thread.id);
    const meta: ThreadMeta = {
      adapterName: adapter,
      channelId: thread.channelId,
      threadId: thread.id,
      channelKey,
      threadKey,
      isDM: thread.isDM,
    };
    const identity = loadIdentity(dataDir);
    const memory = formatMemory(dataDir, meta);
    const skills = loadSkills(dataDir, meta);
    const systemPrompt = buildSystemPrompt({
      dataDir,
      identity,
      memory,
      skills,
      sandbox,
      settings,
      threadMeta: meta,
    });
    const tools = buildTools({
      sandbox,
      workspacePath: sandbox.workspacePath,
      thread,
    });

    return new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        thinkingLevel: settings.defaultThinkingLevel,
      },
      getApiKey: (provider) => process.env[`${provider.toUpperCase()}_API_KEY`],
    });
  };
}
