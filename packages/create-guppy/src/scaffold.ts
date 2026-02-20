import { cp, mkdir, readdir } from "fs/promises";
import { join, dirname } from "path";

interface ScaffoldOptions {
  /** Override dependency versions in generated package.json (e.g. point @guppy/web at a tarball) */
  packageOverrides?: Record<string, string>;
}

const templateDir = join(dirname(import.meta.dir), "template");

async function getPkgVersion(name: string): Promise<string> {
  const pkgPath = require.resolve(`${name}/package.json`);
  const pkg: { version: string } = await Bun.file(pkgPath).json();
  return pkg.version;
}

export async function scaffold(targetDir: string, options?: ScaffoldOptions) {
  await mkdir(targetDir, { recursive: true });

  // Copy template/ → targetDir recursively
  await cp(templateDir, targetDir, { recursive: true });

  const [webVersion, coreVersion, transportWsVersion] = await Promise.all([
    getPkgVersion("@guppy/web"),
    getPkgVersion("@guppy/core"),
    getPkgVersion("@guppy/transport-ws"),
  ]);

  // Build package.json dynamically
  const pkg: Record<string, unknown> = {
    name: "guppy-app",
    private: true,
    type: "module",
    scripts: {
      dev: "bun --hot start.ts",
    },
    dependencies: {
      "@guppy/core": `^${coreVersion}`,
      "@guppy/transport-ws": `^${transportWsVersion}`,
      "@guppy/web": `^${webVersion}`,
      react: "^19",
      "react-dom": "^19",
      "react-router": "^7",
    },
    devDependencies: {
      "@types/react": "^19",
      "@types/react-dom": "^19",
      "bun-plugin-tailwind": "^0.1",
      tailwindcss: "^4",
    },
  };

  // When using local tarballs, add overrides so bun uses them for transitive
  // resolution too (e.g. @guppy/web's dep on @guppy/core)
  if (options?.packageOverrides) {
    pkg.overrides = { ...options.packageOverrides };
  }

  await Bun.write(join(targetDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  const files = await readdir(targetDir, { recursive: true });
  return { targetDir, files };
}
