import { cp, mkdir, readdir } from "fs/promises";
import { join, dirname } from "path";

interface ScaffoldOptions {
  /** Override dependency versions in generated package.json (e.g. point @guppy/web at a tarball) */
  packageOverrides?: Record<string, string>;
}

const templateDir = join(dirname(import.meta.dir), "template");

export async function scaffold(targetDir: string, options?: ScaffoldOptions) {
  await mkdir(targetDir, { recursive: true });

  // Copy template/ → targetDir recursively
  await cp(templateDir, targetDir, { recursive: true });

  // Build package.json dynamically
  const pkg = {
    name: "guppy-app",
    private: true,
    type: "module",
    scripts: {
      dev: "bun --hot start.ts",
    },
    dependencies: {
      "@guppy/web": "workspace:*",
      react: "^19",
      "react-dom": "^19",
      "react-router": "^7",
      ...options?.packageOverrides,
    },
    devDependencies: {
      "@types/react": "^19",
      "@types/react-dom": "^19",
      "bun-plugin-tailwind": "^0.1",
      tailwindcss: "^4",
    },
  };

  await Bun.write(join(targetDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  // Verify files were copied
  const files = await readdir(targetDir, { recursive: true });
  console.log(`[scaffold] Created ${files.length} files in ${targetDir}`);

  return { targetDir, files };
}
