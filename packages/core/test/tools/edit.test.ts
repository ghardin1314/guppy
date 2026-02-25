import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEditTool } from "../../src/tools/edit";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "guppy-edit-tool-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("edit tool", () => {
  test("has correct metadata", () => {
    const tool = createEditTool(workDir);
    expect(tool.name).toBe("edit");
  });

  test("replaces a unique match", async () => {
    writeFileSync(join(workDir, "file.txt"), "hello world\ngoodbye world");
    const tool = createEditTool(workDir);
    await tool.execute("e1", {
      path: "file.txt",
      old_string: "hello",
      new_string: "hi",
    });

    expect(readFileSync(join(workDir, "file.txt"), "utf-8")).toBe(
      "hi world\ngoodbye world",
    );
  });

  test("returns line number of replacement", async () => {
    writeFileSync(
      join(workDir, "lines.txt"),
      "aaa\nbbb\nccc\nddd",
    );
    const tool = createEditTool(workDir);
    const result = await tool.execute("e2", {
      path: "lines.txt",
      old_string: "ccc",
      new_string: "CCC",
    });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("line 3");
  });

  test("errors when no match found", async () => {
    writeFileSync(join(workDir, "file.txt"), "hello");
    const tool = createEditTool(workDir);
    await expect(
      tool.execute("e3", {
        path: "file.txt",
        old_string: "nope",
        new_string: "yes",
      }),
    ).rejects.toThrow("No match found");
  });

  test("errors when multiple matches without replace_all", async () => {
    writeFileSync(join(workDir, "file.txt"), "foo bar foo baz foo");
    const tool = createEditTool(workDir);
    await expect(
      tool.execute("e4", {
        path: "file.txt",
        old_string: "foo",
        new_string: "qux",
      }),
    ).rejects.toThrow("Found 3 matches");
  });

  test("replace_all replaces all occurrences", async () => {
    writeFileSync(join(workDir, "file.txt"), "foo bar foo baz foo");
    const tool = createEditTool(workDir);
    const result = await tool.execute("e5", {
      path: "file.txt",
      old_string: "foo",
      new_string: "qux",
      replace_all: true,
    });

    expect(readFileSync(join(workDir, "file.txt"), "utf-8")).toBe(
      "qux bar qux baz qux",
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("3 occurrences");
  });

  test("errors for missing file", async () => {
    const tool = createEditTool(workDir);
    await expect(
      tool.execute("e6", {
        path: "missing.txt",
        old_string: "a",
        new_string: "b",
      }),
    ).rejects.toThrow("File not found");
  });

  test("handles multiline old_string", async () => {
    writeFileSync(join(workDir, "multi.txt"), "line1\nline2\nline3");
    const tool = createEditTool(workDir);
    await tool.execute("e7", {
      path: "multi.txt",
      old_string: "line1\nline2",
      new_string: "replaced",
    });

    expect(readFileSync(join(workDir, "multi.txt"), "utf-8")).toBe(
      "replaced\nline3",
    );
  });
});
