import * as p from "@clack/prompts";
import { getModels } from "@mariozechner/pi-ai";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { getAllTransports } from "./transports/registry";
import { SUPPORTED_PROVIDERS, getProviderEnvVar } from "./providers";
import type { TransportId, CredentialField } from "./transports/types";
import type { DeployTarget } from "./scaffold/templates/deploy";

export interface ModelSelection {
  provider: string;
  modelId: string;
}

export function intro(): void {
  p.intro("guppy create");
}

export function outro(message: string): void {
  p.outro(message);
}

export async function promptBotName(defaultName?: string): Promise<string> {
  const name = await p.text({
    message: "Bot name",
    placeholder: defaultName ?? "my-agent",
    validate: (v = "") => {
      if (!v.trim()) return "Name is required";
      if (!/^[a-z0-9-]+$/.test(v)) return "Use lowercase letters, numbers, and hyphens only";
    },
  });
  if (p.isCancel(name)) process.exit(0);
  return name;
}

export async function promptModel(): Promise<ModelSelection> {
  const provider = await p.select({
    message: "Model provider?",
    options: SUPPORTED_PROVIDERS.map((sp) => ({
      value: sp.id,
      label: sp.displayName,
    })),
  });
  if (p.isCancel(provider)) process.exit(0);

  const models = getModels(provider as KnownProvider).toReversed();
  const modelId = await p.select({
    message: "Model?",
    options: models.map((m) => ({
      value: m.id,
      label: m.name,
      hint: m.reasoning ? "reasoning" : undefined,
    })),
  });
  if (p.isCancel(modelId)) process.exit(0);

  return { provider, modelId };
}

export async function promptApiKey(provider: string): Promise<string> {
  const envVar = getProviderEnvVar(provider);
  const key = await p.password({
    message: `${envVar}`,
  });
  if (p.isCancel(key)) process.exit(0);
  return key;
}

export async function promptTransports(): Promise<TransportId[]> {
  const all = getAllTransports();
  const selected = await p.multiselect({
    message: "Which transports?",
    options: all.map((t) => ({
      value: t.id,
      label: t.displayName,
    })),
    required: false,
  });
  if (p.isCancel(selected)) process.exit(0);
  return selected;
}

export async function promptSingleTransport(
  exclude: TransportId[] = [],
): Promise<TransportId> {
  const all = getAllTransports().filter((t) => !exclude.includes(t.id));
  if (all.length === 0) {
    p.log.warn("All transports are already configured.");
    process.exit(0);
  }
  const selected = await p.select({
    message: "Which transport to add?",
    options: all.map((t) => ({
      value: t.id,
      label: t.displayName,
    })),
  });
  if (p.isCancel(selected)) process.exit(0);
  return selected;
}

export async function promptCredentials(
  credentials: CredentialField[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const cred of credentials) {
    const fn = cred.isSecret ? p.password : p.text;
    const value = await fn({
      message: `${cred.name} (${cred.envVar})`,
      ...(cred.isSecret ? {} : { placeholder: cred.description }),
    });
    if (p.isCancel(value)) process.exit(0);
    values[cred.envVar] = value;
  }
  return values;
}

export async function promptBaseUrl(): Promise<string> {
  const url = await p.text({
    message: "Base URL (where the bot will be reachable)",
    placeholder: "https://my-bot.example.com",
  });
  if (p.isCancel(url)) process.exit(0);
  return url;
}

export async function promptDeployTarget(): Promise<DeployTarget> {
  const target = await p.select({
    message: "Deployment target?",
    options: [
      { value: "manual" as const, label: "Manual (no infra files)" },
      { value: "docker-compose" as const, label: "Docker Compose" },
      { value: "systemd" as const, label: "systemd" },
      { value: "railway" as const, label: "Railway" },
      { value: "fly" as const, label: "Fly.io" },
    ],
  });
  if (p.isCancel(target)) process.exit(0);
  return target;
}

export function spinner() {
  return p.spinner();
}

export const log = p.log;
