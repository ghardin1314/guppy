import { test, expect, beforeAll, describe } from "bun:test";
import { scaffold } from "../src/scaffold.ts";
import { mkdtemp, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $, type Subprocess } from "bun";
const webPkgDir = join(import.meta.dir, "../../web");
const corePkgDir = join(import.meta.dir, "../../core");
let webTarball: string;
let coreTarball: string;
let webVersion: string;
let coreVersion: string;

beforeAll(async () => {
  // Pack @guppy/web and @guppy/core into tarballs for integration tests
  const [webResult, coreResult] = await Promise.all([
    $`cd ${webPkgDir} && bun pm pack`.text(),
    $`cd ${corePkgDir} && bun pm pack`.text(),
  ]);
  const parseTgz = (output: string) => output.split("\n").find((l) => l.trim().endsWith(".tgz") && !l.includes(" "))!.trim();
  webTarball = join(webPkgDir, parseTgz(webResult));
  coreTarball = join(corePkgDir, parseTgz(coreResult));

  const webPkg: { version: string } = await Bun.file(join(webPkgDir, "package.json")).json();
  webVersion = webPkg.version;
  const corePkg: { version: string } = await Bun.file(join(corePkgDir, "package.json")).json();
  coreVersion = corePkg.version;
});

describe("scaffold", () => {
  test("creates expected file structure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
    try {
      await scaffold(dir);

      const files = await readdir(dir, { recursive: true });
      const fileSet = new Set(files);

      // Template files
      expect(fileSet.has("start.ts")).toBe(true);
      expect(fileSet.has("shell.html")).toBe(true);
      expect(fileSet.has("app.tsx")).toBe(true);
      expect(fileSet.has("bunfig.toml")).toBe(true);
      expect(fileSet.has("tsconfig.json")).toBe(true);
      expect(fileSet.has(".gitignore")).toBe(true);
      expect(fileSet.has(join("pages", "index.tsx"))).toBe(true);
      expect(fileSet.has(join("routes", "health.ts"))).toBe(true);
      expect(fileSet.has(join("styles", "global.css"))).toBe(true);

      // Dynamically generated
      expect(fileSet.has("package.json")).toBe(true);

      // Verify package.json content
      const pkg = await Bun.file(join(dir, "package.json")).json();
      expect(pkg.name).toBe("guppy-app");
      expect(pkg.dependencies["@guppy/core"]).toBe(`^${coreVersion}`);
      expect(pkg.dependencies["@guppy/web"]).toBe(`^${webVersion}`);
      expect(pkg.dependencies["react"]).toBeDefined();
      expect(pkg.dependencies["react-router"]).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("packageOverrides are applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
    const override = `file:./guppy-web-${webVersion}.tgz`;
    try {
      await scaffold(dir, {
        packageOverrides: { "@guppy/web": override },
      });

      const pkg = await Bun.file(join(dir, "package.json")).json();
      expect(pkg.overrides["@guppy/web"]).toBe(override);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("server boots and serves pages + API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
    let proc: Subprocess | undefined;

    try {
      // Scaffold with tarball overrides
      await scaffold(dir, {
        packageOverrides: {
          "@guppy/core": `file:${coreTarball}`,
          "@guppy/web": `file:${webTarball}`,
        },
      });

      // Install dependencies
      await $`cd ${dir} && bun install`.quiet();

      // Pick a random port to avoid conflicts
      const port = 10000 + Math.floor(Math.random() * 50000);

      // Boot the server
      proc = Bun.spawn(["bun", "--hot", "start.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PORT: String(port) },
      });

      // Poll /api/health until ready (max 30s)
      const base = `http://localhost:${port}`;
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // not up yet
        }
        await Bun.sleep(200);
      }
      expect(ready).toBe(true);

      // GET / → 200, HTML with <div id="root">
      const indexRes = await fetch(base);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(html).toContain('<div id="root">');

      // GET /api/health → 200, JSON with status: "ok"
      const healthRes = await fetch(`${base}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as { status: string };
      expect(healthData.status).toBe("ok");
    } finally {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
