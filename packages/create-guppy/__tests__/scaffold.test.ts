import { test, expect, beforeAll, describe } from "bun:test";
import { scaffold } from "../src/scaffold.ts";
import { mkdtemp, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $, type Subprocess } from "bun";
const webPkgDir = join(import.meta.dir, "../../web");
const corePkgDir = join(import.meta.dir, "../../core");
const transportWsPkgDir = join(import.meta.dir, "../../transport-ws");
let webTarball: string;
let coreTarball: string;
let transportWsTarball: string;
let webVersion: string;
let coreVersion: string;
let transportWsVersion: string;

beforeAll(async () => {
  // Pack @guppy/web, @guppy/core, and @guppy/transport-ws into tarballs for integration tests
  const [webResult, coreResult, transportWsResult] = await Promise.all([
    $`cd ${webPkgDir} && bun pm pack`.text(),
    $`cd ${corePkgDir} && bun pm pack`.text(),
    $`cd ${transportWsPkgDir} && bun pm pack`.text(),
  ]);
  const parseTgz = (output: string) => output.split("\n").find((l) => l.trim().endsWith(".tgz") && !l.includes(" "))!.trim();
  webTarball = join(webPkgDir, parseTgz(webResult));
  coreTarball = join(corePkgDir, parseTgz(coreResult));
  transportWsTarball = join(transportWsPkgDir, parseTgz(transportWsResult));

  const webPkg: { version: string } = await Bun.file(join(webPkgDir, "package.json")).json();
  webVersion = webPkg.version;
  const corePkg: { version: string } = await Bun.file(join(corePkgDir, "package.json")).json();
  coreVersion = corePkg.version;
  const transportWsPkg: { version: string } = await Bun.file(join(transportWsPkgDir, "package.json")).json();
  transportWsVersion = transportWsPkg.version;
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
      expect(pkg.dependencies["@guppy/transport-ws"]).toBe(`^${transportWsVersion}`);
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
          "@guppy/transport-ws": `file:${transportWsTarball}`,
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

  test("WebSocket connects and receives agent events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
    let proc: Subprocess | undefined;

    try {
      await scaffold(dir, {
        packageOverrides: {
          "@guppy/core": `file:${coreTarball}`,
          "@guppy/transport-ws": `file:${transportWsTarball}`,
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

      // Connect WebSocket
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      const messages: unknown[] = [];

      const connected = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WS connect timeout")), 5_000);
        ws.onmessage = (event) => {
          const msg = JSON.parse(String(event.data));
          messages.push(msg);
          if (msg.type === "connected") {
            clearTimeout(timeout);
            resolve();
          }
        };
        ws.onerror = (e) => {
          clearTimeout(timeout);
          reject(e);
        };
      });

      await connected;

      // Verify connected message
      const connectedMsg = messages[0] as { type: string; channelId: string };
      expect(connectedMsg.type).toBe("connected");
      expect(typeof connectedMsg.channelId).toBe("string");

      // Send a prompt
      ws.send(JSON.stringify({
        type: "prompt",
        threadId: "test-thread",
        content: "hello",
      }));

      // Collect messages until we get an agent_event (5s timeout)
      const gotAgentEvent = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("No agent_event within 5s")), 5_000);
        ws.onmessage = (event) => {
          const msg = JSON.parse(String(event.data));
          messages.push(msg);
          if (msg.type === "agent_event") {
            clearTimeout(timeout);
            resolve();
          }
        };
      });

      await gotAgentEvent;

      const agentEvents = messages.filter(
        (m): m is { type: string; threadId: string; event: unknown } =>
          (m as { type: string }).type === "agent_event",
      );
      expect(agentEvents.length).toBeGreaterThanOrEqual(1);
      expect(agentEvents[0]!.threadId).toBe("test-thread");

      ws.close();
    } finally {
      if (proc) {
        proc.kill();
        await proc.exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
