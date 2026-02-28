import { join } from "node:path";

/** Read @guppy/core version from workspace package.json. */
async function getCoreVersion(): Promise<string> {
  const pkgPath = join(import.meta.dir, "../../../../core/package.json");
  try {
    const pkg = await Bun.file(pkgPath).json();
    return `^${pkg.version}`;
  } catch {
    return "^0.0.1";
  }
}

export async function generatePackageJson(
  name: string,
  extraDeps?: Record<string, string>,
): Promise<string> {
  const coreVersion = await getCoreVersion();
  const deps: Record<string, string> = {
    "@chat-adapter/state-memory": "^4.15.0",
    "@guppy/core": coreVersion,
    "@mariozechner/pi-agent-core": "^0.55.1",
    "@mariozechner/pi-ai": "^0.55.1",
    chat: "^4.15.0",
    ...extraDeps,
  };

  // Sort dependencies alphabetically
  const sorted = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );

  const pkg = {
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "bun --watch src/index.ts",
      start: "bun src/index.ts",
      typecheck: "tsc --noEmit",
    },
    dependencies: sorted,
    devDependencies: {
      "@types/bun": "^1.3.9",
      typescript: "^5.7.2",
    },
  };

  return JSON.stringify(pkg, null, 2) + "\n";
}

export const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "rootDir": "src",
    "types": ["@types/bun"]
  },
  "include": ["src"]
}
`;

export const GITIGNORE = `node_modules/
dist/
.env
data/*/
!data/skills/
`;

export function generateEnv(entries: Record<string, string> = {}): string {
  const lines: string[] = [];

  // Provider API key first (whatever it is), then PORT and BASE_URL
  for (const [key, value] of Object.entries(entries)) {
    if (key === "PORT" || key === "BASE_URL") continue;
    lines.push(`${key}=${value}`);
  }

  lines.push(`PORT=${entries.PORT ?? "80"}`);
  lines.push(`BASE_URL=${entries.BASE_URL ?? ""}`);

  return lines.join("\n") + "\n";
}
