import { test, expect, describe } from "bun:test";
import { mkdtemp, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

const cliBin = join(import.meta.dir, "../src/bin.ts");

describe("guppy init", () => {
  test("scaffolds project from CLI argument", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-cli-init-"));
    const projectDir = join(dir, "my-app");
    try {
      const result = await $`bun ${cliBin} init --skip-install ${projectDir}`.text();
      expect(result).toContain("Project scaffolded");

      const files = await readdir(projectDir, { recursive: true });
      const fileSet = new Set(files);
      expect(fileSet.has("start.ts")).toBe(true);
      expect(fileSet.has("shell.html")).toBe(true);
      expect(fileSet.has("app.tsx")).toBe(true);
      expect(fileSet.has("package.json")).toBe(true);
      expect(fileSet.has(join("pages", "index.tsx"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("scaffolds project with absolute path argument", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-cli-init-"));
    const projectDir = join(dir, "custom-dir");
    try {
      await $`bun ${cliBin} init --skip-install ${projectDir}`.text();

      const files = await readdir(projectDir, { recursive: true });
      const fileSet = new Set(files);
      expect(fileSet.has("start.ts")).toBe(true);
      expect(fileSet.has("package.json")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
