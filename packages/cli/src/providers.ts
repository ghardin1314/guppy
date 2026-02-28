/**
 * Provider metadata not available from pi-ai at runtime
 * (env var names and curated display list for the CLI).
 */

export interface SupportedProvider {
  id: string;
  displayName: string;
  envVar: string;
}

/** Providers offered in the CLI create flow. */
export const SUPPORTED_PROVIDERS: SupportedProvider[] = [
  { id: "anthropic", displayName: "Anthropic", envVar: "ANTHROPIC_API_KEY" },
  { id: "openai", displayName: "OpenAI", envVar: "OPENAI_API_KEY" },
  { id: "google", displayName: "Google", envVar: "GEMINI_API_KEY" },
  { id: "mistral", displayName: "Mistral", envVar: "MISTRAL_API_KEY" },
  { id: "xai", displayName: "xAI", envVar: "XAI_API_KEY" },
  { id: "groq", displayName: "Groq", envVar: "GROQ_API_KEY" },
  { id: "openrouter", displayName: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
];

const envVarMap = new Map(SUPPORTED_PROVIDERS.map((p) => [p.id, p.envVar]));

export function getProviderEnvVar(providerId: string): string {
  return envVarMap.get(providerId) ?? `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}
