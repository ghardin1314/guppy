import { existsSync } from "node:fs";
import { join } from "node:path";
import { addTransport } from "../scaffold/engine";
import { getTransport, getAllTransports } from "../transports/registry";
import type { TransportId } from "../transports/types";
import * as ui from "../prompts";

/** Detect which transports are already imported in index.ts. */
async function detectExisting(projectDir: string): Promise<TransportId[]> {
  const indexPath = join(projectDir, "src", "index.ts");
  if (!existsSync(indexPath)) return [];

  const content = await Bun.file(indexPath).text();
  const existing: TransportId[] = [];
  for (const t of getAllTransports()) {
    if (content.includes(t.adapterPackage)) {
      existing.push(t.id);
    }
  }
  return existing;
}

export async function addTransportCommand(
  projectDir: string,
  transportId?: TransportId,
): Promise<void> {
  // Validate project
  const indexPath = join(projectDir, "src", "index.ts");
  if (!existsSync(indexPath)) {
    ui.log.error("No src/index.ts found. Run this from a guppy project root.");
    process.exit(1);
  }

  const existing = await detectExisting(projectDir);
  if (existing.length > 0) {
    ui.log.info(`Already configured: ${existing.join(", ")}`);
  }

  // Prompt for transport
  const id = transportId ?? (await ui.promptSingleTransport(existing));
  const transport = getTransport(id);

  // Prompt for credentials
  ui.log.info(`Configure ${transport.displayName} (${transport.docsUrl})`);
  const envValues = await ui.promptCredentials(transport.credentials);

  // Inject
  const s = ui.spinner();
  s.start(`Adding ${transport.displayName}`);
  await addTransport(projectDir, id, envValues);
  s.stop(`${transport.displayName} added`);

  // Reinstall deps
  s.start("Installing dependencies");
  const install = Bun.spawn(["bun", "install"], {
    cwd: projectDir,
    stdio: ["ignore", "ignore", "ignore"],
  });
  await install.exited;
  if (install.exitCode !== 0) {
    s.stop("Dependency install failed — run `bun install` manually");
  } else {
    s.stop("Dependencies installed");
  }

  ui.outro(`${transport.displayName} is ready!`);
}
