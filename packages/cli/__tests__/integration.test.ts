import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

const cliBin = join(import.meta.dir, "../src/bin.ts");

describe("guppy init → start e2e", () => {
  test("scaffold, boot server, verify HTTP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-cli-e2e-"));
    const projectDir = join(dir, "test-app");
    let proc: import("bun").Subprocess | undefined;

    try {
      // Init project with --local to use workspace @guppy/web
      await $`bun ${cliBin} init --local ${projectDir}`.quiet();

      // Pick a random port
      const port = 10000 + Math.floor(Math.random() * 50000);

      // Start via CLI with --port
      proc = Bun.spawn(["bun", cliBin, "start", "--port", String(port)], {
        cwd: projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });

      // Poll /api/health until ready
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

      // GET / → 200, HTML shell
      const indexRes = await fetch(base);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(html).toContain('<div id="root">');

      // GET /api/health → 200, JSON
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
  }, 60_000);
});
