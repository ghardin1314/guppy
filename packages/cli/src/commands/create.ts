import { join } from "node:path";
import { existsSync } from "node:fs";
import { scaffoldBlank, addTransport } from "../scaffold/engine";
import { getTransport } from "../transports/registry";
import type { TransportId } from "../transports/types";
import type { DeployTarget } from "../scaffold/templates/deploy";
import * as ui from "../prompts";

interface CreateFlags {
  name?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  envVars?: Record<string, string>;
  transports?: TransportId[];
  baseUrl?: string;
  deployTarget?: DeployTarget;
}

export async function create(flags: CreateFlags): Promise<void> {
  ui.intro();

  const env = flags.envVars ?? {};

  // 1. Bot name
  const name = flags.name ?? (await ui.promptBotName());
  const dir = join(process.cwd(), name);

  if (existsSync(dir)) {
    ui.log.error(`Directory "${name}" already exists.`);
    process.exit(1);
  }

  // 2. Model
  let provider = flags.provider;
  let modelId = flags.model;
  if (!provider || !modelId) {
    const selection = await ui.promptModel();
    provider = selection.provider;
    modelId = selection.modelId;
  }

  // 3. Provider API key
  const apiKey = flags.apiKey ?? (await ui.promptApiKey(provider));

  // 4. Transports
  const transportIds = flags.transports ?? (await ui.promptTransports());

  // 5. Credentials per transport — skip prompt if all creds provided via --env
  const transportCredentials: Record<string, Record<string, string>> = {};
  for (const id of transportIds) {
    const t = getTransport(id);
    const allProvided = t.credentials.every((c) => c.envVar in env);
    if (allProvided) {
      const creds: Record<string, string> = {};
      for (const c of t.credentials) {
        creds[c.envVar] = env[c.envVar];
      }
      transportCredentials[id] = creds;
    } else {
      ui.log.info(`Configure ${t.displayName} (${t.docsUrl})`);
      transportCredentials[id] = await ui.promptCredentials(t.credentials);
    }
  }

  // 6. Base URL
  const baseUrl = flags.baseUrl ?? (await ui.promptBaseUrl());

  // 7. Deploy target
  const deployTarget = flags.deployTarget ?? (await ui.promptDeployTarget());

  // 8. Scaffold
  const s = ui.spinner();
  s.start("Scaffolding project");

  await scaffoldBlank({ name, dir, provider, modelId, apiKey, deployTarget, baseUrl });

  for (const id of transportIds) {
    await addTransport(dir, id, transportCredentials[id]);
  }

  s.stop("Project scaffolded");

  // 9. Install dependencies
  s.start("Installing dependencies");
  const install = Bun.spawn(["bun", "install"], { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  await install.exited;
  if (install.exitCode !== 0) {
    s.stop("Dependency install failed — run `bun install` manually");
  } else {
    s.stop("Dependencies installed");
  }

  // 10. Next steps
  ui.log.success("Done! Next steps:");
  ui.log.message(`  cd ${name}`);
  ui.log.message("  # Review .env");
  ui.log.message("  bun run dev");

  ui.outro("Happy building!");
}
