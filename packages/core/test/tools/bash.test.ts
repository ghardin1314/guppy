import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostSandbox } from "../../src/sandbox";
import { createBashTool } from "../../src/tools/bash";

const workDir = mkdtempSync(join(tmpdir(), "guppy-bash-tool-"));
const sandbox = createHostSandbox(workDir);
const tool = createBashTool(sandbox);

describe("bash tool", () => {
  test("has correct metadata", () => {
    expect(tool.name).toBe("bash");
    expect(tool.label).toBe("Bash");
    expect(tool.description).toBeTruthy();
  });

  test("executes a command and returns text content", async () => {
    const result = await tool.execute("call-1", { command: "echo hello" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text.trim()).toBe("hello");
  });

  test("throws on non-zero exit code", async () => {
    await expect(
      tool.execute("call-2", { command: "exit 1" }),
    ).rejects.toThrow("Command failed (exit 1)");
  });

  test("throws on timeout", async () => {
    await expect(
      tool.execute("call-3", { command: "sleep 10", timeout: 0.5 }),
    ).rejects.toThrow("timed out");
  });

  test("includes output in error messages", async () => {
    try {
      await tool.execute("call-4", { command: 'echo oops && exit 1' });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("oops");
    }
  });
});
