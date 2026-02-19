import { test, expect, beforeAll, describe } from "bun:test";
import { scaffold } from "../src/scaffold.ts";
import { mkdtemp, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";
const webPkgDir = join(import.meta.dir, "../../web");
let tarballPath: string;
let webVersion: string;

beforeAll(async () => {
  // Pack @guppy/web into a tarball for integration tests
  const result = await $`cd ${webPkgDir} && bun pm pack`.text();
  const filename = result.split("\n").find((l) => l.endsWith(".tgz"))!.trim();
  tarballPath = join(webPkgDir, filename);

  const webPkg: { version: string } = await Bun.file(join(webPkgDir, "package.json")).json();
  webVersion = webPkg.version;
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
      expect(pkg.dependencies["@guppy/web"]).toBe(`^${webVersion}`);
      expect(pkg.dependencies["react"]).toBeDefined();
      expect(pkg.dependencies["react-router"]).toBeDefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("packageOverrides are applied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
    try {
      await scaffold(dir, {
        packageOverrides: {
          "@guppy/web": "file:./guppy-web-0.0.0.tgz",
        },
      });

      const pkg = await Bun.file(join(dir, "package.json")).json();
      expect(pkg.dependencies["@guppy/web"]).toBe("file:./guppy-web-0.0.0.tgz");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("server boots and serves pages + API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
    let proc: import("bun").Subprocess | undefined;

    try {
      // Scaffold with tarball override
      await scaffold(dir, {
        packageOverrides: {
          "@guppy/web": `file:${tarballPath}`,
        },
      });

      // Install dependencies
      await $`cd ${dir} && bun install`.quiet();

      // Pick a random port to avoid conflicts
      const port = 10000 + Math.floor(Math.random() * 50000);

      // Patch start.ts to use our random port
      const startFile = join(dir, "start.ts");
      const startContent = await Bun.file(startFile).text();
      await Bun.write(
        startFile,
        startContent.replace(
          "await createServer(import.meta.dir, shell);",
          `await createServer(import.meta.dir, shell, { port: ${port} });`
        )
      );

      // Boot the server
      proc = Bun.spawn(["bun", "--hot", "start.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
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
