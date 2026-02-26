import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIdentity } from "../src/identity";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-sysprompt-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("loadIdentity", () => {
  test("reads IDENTITY.md", () => {
    writeFileSync(join(dataDir, "IDENTITY.md"), "You are Guppy. Be helpful.");
    expect(loadIdentity(dataDir)).toBe("You are Guppy. Be helpful.");
  });

  test("trims whitespace", () => {
    writeFileSync(join(dataDir, "IDENTITY.md"), "  Hello  \n");
    expect(loadIdentity(dataDir)).toBe("Hello");
  });

  test("returns default when file missing", () => {
    expect(loadIdentity(dataDir)).toBe(
      "You are a chat assistant. Be concise. No emojis.",
    );
  });

  test("returns default when file is empty", () => {
    writeFileSync(join(dataDir, "IDENTITY.md"), "   ");
    expect(loadIdentity(dataDir)).toBe(
      "You are a chat assistant. Be concise. No emojis.",
    );
  });
});
