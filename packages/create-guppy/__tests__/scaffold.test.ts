import { test, expect, beforeAll, describe } from "bun:test";
import { scaffold } from "../src/scaffold.ts";
import { mkdtemp, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $, type Subprocess } from "bun";
const webPkgDir = join(import.meta.dir, "../../web");
const corePkgDir = join(import.meta.dir, "../../core");
const transportSsePkgDir = join(import.meta.dir, "../../transport-sse");
let webTarball: string;
let coreTarball: string;
let transportSseTarball: string;
let webVersion: string;
let coreVersion: string;
let transportSseVersion: string;

beforeAll(async () => {
  // Pack @guppy/web, @guppy/core, and @guppy/transport-sse into tarballs for integration tests
  const [webResult, coreResult, transportSseResult] = await Promise.all([
    $`cd ${webPkgDir} && bun pm pack`.text(),
    $`cd ${corePkgDir} && bun pm pack`.text(),
    $`cd ${transportSsePkgDir} && bun pm pack`.text(),
  ]);
  const parseTgz = (output: string) => output.split("\n").find((l) => l.trim().endsWith(".tgz") && !l.includes(" "))!.trim();
  webTarball = join(webPkgDir, parseTgz(webResult));
  coreTarball = join(corePkgDir, parseTgz(coreResult));
  transportSseTarball = join(transportSsePkgDir, parseTgz(transportSseResult));

  const webPkg: { version: string } = await Bun.file(join(webPkgDir, "package.json")).json();
  webVersion = webPkg.version;
  const corePkg: { version: string } = await Bun.file(join(corePkgDir, "package.json")).json();
  coreVersion = corePkg.version;
  const transportSsePkg: { version: string } = await Bun.file(join(transportSsePkgDir, "package.json")).json();
  transportSseVersion = transportSsePkg.version;
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
      expect(fileSet.has(join("pages", "chat.tsx"))).toBe(true);
      expect(fileSet.has(join("procedures", "health.ts"))).toBe(true);
      expect(fileSet.has(join("procedures", "threads.ts"))).toBe(true);
      expect(fileSet.has(join("procedures", "index.ts"))).toBe(true);
      expect(fileSet.has(join("styles", "global.css"))).toBe(true);
      // Tools now live in @guppy/core, not scaffolded locally
      expect(fileSet.has(join("tools", "read.ts"))).toBe(false);
      expect(fileSet.has(join("tools", "bash.ts"))).toBe(false);
      expect(fileSet.has(join("tools", "shared.ts"))).toBe(false);

      // Dynamically generated
      expect(fileSet.has("package.json")).toBe(true);

      // Verify package.json content
      const pkg = await Bun.file(join(dir, "package.json")).json();
      expect(pkg.name).toBe("guppy-app");
      expect(pkg.dependencies["@guppy/core"]).toBe(`^${coreVersion}`);
      expect(pkg.dependencies["@guppy/transport-sse"]).toBe(`^${transportSseVersion}`);
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
          "@guppy/transport-sse": `file:${transportSseTarball}`,
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

  test("SSE connects and receives agent events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
    let proc: Subprocess | undefined;

    try {
      await scaffold(dir, {
        packageOverrides: {
          "@guppy/core": `file:${coreTarball}`,
          "@guppy/transport-sse": `file:${transportSseTarball}`,
          "@guppy/web": `file:${webTarball}`,
        },
      });

      await $`cd ${dir} && bun install`.quiet();

      const port = 10000 + Math.floor(Math.random() * 50000);

      proc = Bun.spawn(["bun", "--hot", "start.ts"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PORT: String(port) },
      });

      // Wait for server to be ready
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

      // Connect SSE to a test thread
      const threadId = "test-thread";
      const response = await fetch(`${base}/events/${threadId}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // Read until we get the "connected" event
      const readUntil = async (eventType: string, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { value, done } = await Promise.race([
            reader.read(),
            Bun.sleep(100).then(() => ({ value: undefined, done: false })),
          ]);
          if (done) break;
          if (value) buffer += decoder.decode(value, { stream: true });
          if (buffer.includes(`event: ${eventType}`)) return true;
        }
        return false;
      };

      const gotConnected = await readUntil("connected", 5_000);
      expect(gotConnected).toBe(true);

      // Send a prompt via RPC
      await fetch(`${base}/rpc/threads/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json: { threadId, content: "hello" } }),
      });

      // Wait for agent_event
      const gotAgentEvent = await readUntil("agent_event", 10_000);
      expect(gotAgentEvent).toBe(true);

      reader.cancel();
    } finally {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
