import type { Model } from "@mariozechner/pi-ai";

const BASE_URL = "https://api.moonshot.ai/v1";
const PROVIDER = "moonshot";

const shared = {
  api: "openai-completions" as const,
  provider: PROVIDER,
  baseUrl: BASE_URL,
};

const sharedCompat = {
  maxTokensField: "max_tokens" as const,
  supportsDeveloperRole: false,
  supportsStore: false,
};

export const kimiK25: Model<"openai-completions"> = {
  ...shared,
  id: "kimi-k2.5",
  name: "Kimi K2.5",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.6, output: 3.0, cacheRead: 0.1, cacheWrite: 0.6 },
  contextWindow: 262144,
  maxTokens: 32768,
  compat: { ...sharedCompat, thinkingFormat: "zai" },
};

export const kimiLatest: Model<"openai-completions"> = {
  ...shared,
  id: "kimi-latest",
  name: "Kimi Latest",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 1.0, output: 3.0, cacheRead: 0.15, cacheWrite: 1.0 },
  contextWindow: 131072,
  maxTokens: 131072,
  compat: sharedCompat,
};

export const kimiK2TurboPreview: Model<"openai-completions"> = {
  ...shared,
  id: "kimi-k2-turbo-preview",
  name: "Kimi K2 Turbo",
  reasoning: false,
  input: ["text"],
  cost: { input: 1.15, output: 8.0, cacheRead: 0.15, cacheWrite: 1.15 },
  contextWindow: 262144,
  maxTokens: 32768,
  compat: sharedCompat,
};

export const kimiK2Thinking: Model<"openai-completions"> = {
  ...shared,
  id: "kimi-k2-thinking",
  name: "Kimi K2 Thinking",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0.6 },
  contextWindow: 262144,
  maxTokens: 32768,
  compat: { ...sharedCompat, thinkingFormat: "zai" },
};

export const moonshotV1_8k: Model<"openai-completions"> = {
  ...shared,
  id: "moonshot-v1-8k",
  name: "Moonshot V1 8K",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.2, output: 2.0, cacheRead: 0.2, cacheWrite: 0.2 },
  contextWindow: 8192,
  maxTokens: 8192,
  compat: sharedCompat,
};

export const moonshotV1_32k: Model<"openai-completions"> = {
  ...shared,
  id: "moonshot-v1-32k",
  name: "Moonshot V1 32K",
  reasoning: false,
  input: ["text"],
  cost: { input: 1.0, output: 3.0, cacheRead: 1.0, cacheWrite: 1.0 },
  contextWindow: 32768,
  maxTokens: 32768,
  compat: sharedCompat,
};

export const moonshotV1_128k: Model<"openai-completions"> = {
  ...shared,
  id: "moonshot-v1-128k",
  name: "Moonshot V1 128K",
  reasoning: false,
  input: ["text"],
  cost: { input: 2.0, output: 5.0, cacheRead: 2.0, cacheWrite: 2.0 },
  contextWindow: 131072,
  maxTokens: 131072,
  compat: sharedCompat,
};

/** All Moonshot models */
export const moonshot = [
  kimiK25,
  kimiLatest,
  kimiK2TurboPreview,
  kimiK2Thinking,
  moonshotV1_8k,
  moonshotV1_32k,
  moonshotV1_128k,
] as const;
