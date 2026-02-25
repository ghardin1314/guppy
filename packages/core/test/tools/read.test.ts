import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadTool } from "../../src/tools/read";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "guppy-read-tool-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("read tool", () => {
  test("has correct metadata", () => {
    const tool = createReadTool(workDir);
    expect(tool.name).toBe("read");
  });

  test("reads a text file with line numbers", async () => {
    writeFileSync(join(workDir, "test.txt"), "line1\nline2\nline3");
    const tool = createReadTool(workDir);
    const result = await tool.execute("r1", { path: "test.txt" });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1\tline1");
    expect(text).toContain("2\tline2");
    expect(text).toContain("3\tline3");
  });

  test("respects offset and limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    writeFileSync(join(workDir, "many.txt"), lines.join("\n"));
    const tool = createReadTool(workDir);
    const result = await tool.execute("r2", {
      path: "many.txt",
      offset: 3,
      limit: 2,
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("3\tline3");
    expect(text).toContain("4\tline4");
    expect(text).not.toContain("line2");
    expect(text).not.toContain("line5");
  });

  test("returns image as base64 ImageContent", async () => {
    // 1x1 red PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(workDir, "pixel.png"), png);
    const tool = createReadTool(workDir);
    const result = await tool.execute("r3", { path: "pixel.png" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("image");
    expect((result.content[0] as { mimeType: string }).mimeType).toContain("image/");
  });

  test("throws for missing file", async () => {
    const tool = createReadTool(workDir);
    await expect(
      tool.execute("r4", { path: "nope.txt" }),
    ).rejects.toThrow("File not found");
  });

  test("resolves relative paths against workspace", async () => {
    mkdirSync(join(workDir, "sub"), { recursive: true });
    writeFileSync(join(workDir, "sub", "file.txt"), "hello");
    const tool = createReadTool(workDir);
    const result = await tool.execute("r5", { path: "sub/file.txt" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("hello");
  });

  test("handles empty file", async () => {
    writeFileSync(join(workDir, "empty.txt"), "");
    const tool = createReadTool(workDir);
    const result = await tool.execute("r6", { path: "empty.txt" });
    expect(result.content).toHaveLength(1);
  });
});
