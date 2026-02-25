import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostSandbox } from "../src/sandbox";

const workDir = realpathSync(mkdtempSync(join(tmpdir(), "guppy-sandbox-")));

describe("createHostSandbox", () => {
  test("runs a simple command", async () => {
    const sandbox = createHostSandbox(workDir);
    const result = await sandbox.exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  test("captures stderr", async () => {
    const sandbox = createHostSandbox(workDir);
    const result = await sandbox.exec("echo err >&2");
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("err");
  });

  test("returns non-zero exit code", async () => {
    const sandbox = createHostSandbox(workDir);
    const result = await sandbox.exec("exit 42");
    expect(result.exitCode).toBe(42);
  });

  test("times out long-running commands", async () => {
    const sandbox = createHostSandbox(workDir);
    const result = await sandbox.exec("sleep 30", { timeout: 500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("respects abort signal", async () => {
    const sandbox = createHostSandbox(workDir);
    const ac = new AbortController();
    const promise = sandbox.exec("sleep 30", { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    const result = await promise;
    // Aborted commands get exitCode 1
    expect(result.exitCode).toBe(1);
  });

  test("uses workspace as default cwd", async () => {
    const sandbox = createHostSandbox(workDir);
    const result = await sandbox.exec("pwd");
    expect(result.output.trim()).toBe(workDir);
  });

  test("respects custom cwd", async () => {
    const sandbox = createHostSandbox(workDir);
    const result = await sandbox.exec("pwd", { cwd: "/tmp" });
    // /tmp may be a symlink on macOS
    expect(result.output.trim()).toMatch(/tmp/);
  });

  test("strips ANSI from output", async () => {
    const sandbox = createHostSandbox(workDir);
    const result = await sandbox.exec('printf "\\033[31mred\\033[0m"');
    expect(result.output).toBe("red");
  });

  test("exposes workspacePath", () => {
    const sandbox = createHostSandbox(workDir);
    expect(sandbox.workspacePath).toBe(workDir);
  });
});
