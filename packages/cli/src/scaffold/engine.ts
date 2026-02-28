import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { insertAtMarker } from "./markers";
import { generateIndexTs } from "./templates/index-ts";
import { getStaticFiles } from "./templates/static";
import { generateIdentityMd, MEMORY_MD, SYSTEM_MD } from "./templates/data";
import {
  generatePackageJson,
  generateEnv,
  TSCONFIG_JSON,
  GITIGNORE,
} from "./templates/project";
import { getDeployFiles, type DeployTarget } from "./templates/deploy";
import { getTransport } from "../transports/registry";
import { getProviderEnvVar } from "../providers";
import type { TransportId } from "../transports/types";

export interface ScaffoldOpts {
  name: string;
  dir: string;
  provider: string;
  modelId: string;
  apiKey?: string;
  deployTarget: DeployTarget;
  baseUrl?: string;
}

/** Scaffold a blank project with markers — no transports wired yet. */
export async function scaffoldBlank(opts: ScaffoldOpts): Promise<void> {
  const { name, dir, provider, modelId, apiKey, deployTarget, baseUrl } = opts;

  // Create directory structure
  await mkdir(join(dir, "src", "inspect"), { recursive: true });
  await mkdir(join(dir, "data", "events"), { recursive: true });
  await mkdir(join(dir, "data", "skills"), { recursive: true });

  // Write index.ts skeleton
  await Bun.write(
    join(dir, "src", "index.ts"),
    generateIndexTs({ botName: name, provider, modelId }),
  );

  // Write static files (system-prompt.ts + inspect/*)
  const staticFiles = await getStaticFiles();
  for (const [relPath, content] of Object.entries(staticFiles)) {
    await Bun.write(join(dir, relPath), content);
  }

  // Write data files
  await Bun.write(join(dir, "data", "IDENTITY.md"), generateIdentityMd(name));
  await Bun.write(join(dir, "data", "MEMORY.md"), MEMORY_MD);
  await Bun.write(join(dir, "data", "SYSTEM.md"), SYSTEM_MD);

  // Write project files
  await Bun.write(join(dir, "package.json"), await generatePackageJson(name));
  await Bun.write(join(dir, "tsconfig.json"), TSCONFIG_JSON);
  await Bun.write(join(dir, ".gitignore"), GITIGNORE);
  const envEntries: Record<string, string> = {};
  const providerEnvVar = getProviderEnvVar(provider);
  envEntries[providerEnvVar] = apiKey ?? "";
  if (baseUrl) envEntries.BASE_URL = baseUrl;
  await Bun.write(join(dir, ".env"), generateEnv(envEntries));

  // Write deployment files
  const deployFiles = getDeployFiles(deployTarget, name);
  for (const f of deployFiles) {
    await Bun.write(join(dir, f.path), f.content);
  }
}

/** Add a transport to an existing project. Inserts at markers in index.ts. */
export async function addTransport(
  projectDir: string,
  transportId: TransportId,
  envValues: Record<string, string>,
): Promise<void> {
  const transport = getTransport(transportId);

  // --- Update index.ts ---
  const indexPath = join(projectDir, "src", "index.ts");
  let index = await Bun.file(indexPath).text();

  // Insert import
  index = insertAtMarker(index, "adapter-imports", transport.adapterImport);

  // Insert adapter entry
  index = insertAtMarker(index, "adapters", transport.adapterEntry);

  // Insert gateway code (Discord)
  if (transport.gatewayCode) {
    index = insertAtMarker(index, "gateway", transport.gatewayCode);
  }

  await Bun.write(indexPath, index);

  // --- Update .env ---
  const envPath = join(projectDir, ".env");
  let env = await Bun.file(envPath).text();
  for (const cred of transport.credentials) {
    const value = envValues[cred.envVar] ?? "";
    env += `${cred.envVar}=${value}\n`;
  }
  await Bun.write(envPath, env);

  // --- Update package.json ---
  const pkgPath = join(projectDir, "package.json");
  const pkg = await Bun.file(pkgPath).json();
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies[transport.adapterPackage] = "^4.15.0";

  // Sort dependencies
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );

  await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}
