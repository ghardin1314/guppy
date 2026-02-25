import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWriteTool } from "../../src/tools/write";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "guppy-write-tool-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("write tool", () => {
  test("has correct metadata", () => {
    const tool = createWriteTool(workDir);
    expect(tool.name).toBe("write");
  });

  test("writes a new file", async () => {
    const tool = createWriteTool(workDir);
    const result = await tool.execute("w1", {
      path: "hello.txt",
      content: "Hello, world!",
    });

    expect(readFileSync(join(workDir, "hello.txt"), "utf-8")).toBe(
      "Hello, world!",
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("13 bytes");
  });

  test("creates parent directories", async () => {
    const tool = createWriteTool(workDir);
    await tool.execute("w2", {
      path: "a/b/c/deep.txt",
      content: "deep",
    });

    expect(readFileSync(join(workDir, "a/b/c/deep.txt"), "utf-8")).toBe("deep");
  });

  test("overwrites existing file", async () => {
    const tool = createWriteTool(workDir);
    await tool.execute("w3", { path: "over.txt", content: "first" });
    await tool.execute("w4", { path: "over.txt", content: "second" });

    expect(readFileSync(join(workDir, "over.txt"), "utf-8")).toBe("second");
  });

  test("returns byte count confirmation", async () => {
    const tool = createWriteTool(workDir);
    const result = await tool.execute("w5", {
      path: "count.txt",
      content: "abc",
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/3 bytes/);
  });
});
