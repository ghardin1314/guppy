import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { truncateHead, truncateTail, MAX_LINES, MAX_BYTES } from "../src/truncate";

describe("truncateTail", () => {
  test("returns text unchanged when within limits", () => {
    const text = "line1\nline2\nline3";
    const result = truncateTail(text);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.totalLines).toBe(3);
    expect(result.fullOutputPath).toBeUndefined();
  });

  test("keeps last N lines when exceeding maxLines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = truncateTail(text, { maxLines: 5, maxBytes: Infinity });

    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(10);
    expect(result.text).toContain("line6");
    expect(result.text).toContain("line10");
    expect(result.text).not.toContain("\nline1\n");
    expect(result.text).toContain("[Showing lines 6-10 of 10.");
  });

  test("writes full output to temp file when truncated", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = truncateTail(text, { maxLines: 3, maxBytes: Infinity });

    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
    expect(existsSync(result.fullOutputPath!)).toBe(true);
    expect(readFileSync(result.fullOutputPath!, "utf-8")).toBe(text);
  });

  test("truncates when exceeding maxBytes even if lines are within limit", () => {
    // Create text that exceeds byte limit but has few lines
    const bigLine = "x".repeat(1024);
    const lines = Array.from({ length: 5 }, () => bigLine);
    const text = lines.join("\n");
    const result = truncateTail(text, { maxLines: 1000, maxBytes: 2048 });

    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
  });

  test("handles empty string", () => {
    const result = truncateTail("");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("");
    expect(result.totalLines).toBe(1);
  });

  test("handles single line", () => {
    const result = truncateTail("hello");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello");
  });
});

describe("truncateHead", () => {
  test("returns text unchanged when within limits", () => {
    const text = "line1\nline2\nline3";
    const result = truncateHead(text);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(text);
    expect(result.totalLines).toBe(3);
  });

  test("keeps first N lines when exceeding maxLines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = truncateHead(text, { maxLines: 5, maxBytes: Infinity });

    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(10);
    expect(result.text).toContain("line1");
    expect(result.text).toContain("line5");
    expect(result.text).not.toContain("\nline6\n");
    expect(result.text).toContain("[Showing lines 1-5 of 10.");
  });

  test("writes full output to temp file when truncated", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const text = lines.join("\n");
    const result = truncateHead(text, { maxLines: 3, maxBytes: Infinity });

    expect(result.truncated).toBe(true);
    expect(result.fullOutputPath).toBeDefined();
    expect(existsSync(result.fullOutputPath!)).toBe(true);
    expect(readFileSync(result.fullOutputPath!, "utf-8")).toBe(text);
  });

  test("truncates on byte limit", () => {
    const bigLine = "x".repeat(1024);
    const lines = Array.from({ length: 5 }, () => bigLine);
    const text = lines.join("\n");
    const result = truncateHead(text, { maxLines: 1000, maxBytes: 2048 });

    expect(result.truncated).toBe(true);
  });

  test("handles empty string", () => {
    const result = truncateHead("");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("");
  });
});

describe("constants", () => {
  test("MAX_LINES is 2000", () => {
    expect(MAX_LINES).toBe(2000);
  });

  test("MAX_BYTES is 50KB", () => {
    expect(MAX_BYTES).toBe(50 * 1024);
  });
});
