import { cp, mkdir, readdir } from "fs/promises";
import { dirname, join } from "path";

interface ScaffoldOptions {
  /** Override dependency versions in generated package.json (e.g. point @guppy/web at a tarball) */
  packageOverrides?: Record<string, string>;
}

// project/ is the canonical template — lives at repo root
const templateDir = join(dirname(import.meta.dir), "../../project");

const EXCLUDE_DIRS = new Set(["node_modules", ".guppy", ".turbo"]);

async function getPkgVersion(name: string): Promise<string> {
  const pkgPath = require.resolve(`${name}/package.json`);
  const pkg: { version: string } = await Bun.file(pkgPath).json();
  return pkg.version;
}

export async function scaffold(targetDir: string, options?: ScaffoldOptions) {
  await mkdir(targetDir, { recursive: true });

  // Copy project/ → targetDir, excluding build artifacts
  await cp(templateDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const base = src.split("/").pop()!;
      return !EXCLUDE_DIRS.has(base);
    },
  });

  // Read project/package.json as base, rewrite workspace:* deps to ^version
  const templatePkg: Record<string, Record<string, string>> = await Bun.file(
    join(templateDir, "package.json"),
  ).json();

  const [webVersion, coreVersion, transportSseVersion] = await Promise.all([
    getPkgVersion("@guppy/web"),
    getPkgVersion("@guppy/core"),
    getPkgVersion("@guppy/transport-sse"),
  ]);

  const versionMap: Record<string, string> = {
    "@guppy/core": `^${coreVersion}`,
    "@guppy/transport-sse": `^${transportSseVersion}`,
    "@guppy/web": `^${webVersion}`,
  };

  // Rewrite workspace:* → ^version in dependencies
  const deps = { ...templatePkg.dependencies };
  for (const [name, ver] of Object.entries(deps)) {
    if (ver.startsWith("workspace:")) {
      deps[name] = versionMap[name] ?? ver;
    }
  }

  const pkg: Record<string, unknown> = {
    ...templatePkg,
    dependencies: deps,
  };

  // When using local tarballs, add overrides so bun uses them for transitive
  // resolution too (e.g. @guppy/web's dep on @guppy/core)
  if (options?.packageOverrides) {
    pkg.overrides = { ...options.packageOverrides };
  }

  await Bun.write(
    join(targetDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );

  const files = await readdir(targetDir, { recursive: true });
  return { targetDir, files };
}
