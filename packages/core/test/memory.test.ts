import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatMemory } from "../src/memory";
import type { ThreadMeta } from "../src/types";

let dataDir: string;

const meta: ThreadMeta = {
  adapterName: "slack",
  channelId: "C123ABC",
  threadId: "1234.5678",
  isDM: false,
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-memory-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("formatMemory", () => {
  test("returns '(no memory yet)' when all empty", () => {
    expect(formatMemory(dataDir, meta)).toBe("(no memory yet)");
  });

  test("reads global memory only", () => {
    writeFileSync(join(dataDir, "MEMORY.md"), "global stuff");
    const result = formatMemory(dataDir, meta);
    expect(result).toBe("### Global Memory\nglobal stuff");
  });

  test("reads transport memory only", () => {
    mkdirSync(join(dataDir, "slack"), { recursive: true });
    writeFileSync(join(dataDir, "slack", "MEMORY.md"), "transport stuff");
    const result = formatMemory(dataDir, meta);
    expect(result).toBe("### Transport Memory (slack)\ntransport stuff");
  });

  test("reads channel memory only", () => {
    mkdirSync(join(dataDir, "slack", "C123ABC"), { recursive: true });
    writeFileSync(join(dataDir, "slack", "C123ABC", "MEMORY.md"), "channel stuff");
    const result = formatMemory(dataDir, meta);
    expect(result).toBe("### Channel Memory\nchannel stuff");
  });

  test("reads all 3 levels", () => {
    writeFileSync(join(dataDir, "MEMORY.md"), "global");
    mkdirSync(join(dataDir, "slack"), { recursive: true });
    writeFileSync(join(dataDir, "slack", "MEMORY.md"), "transport");
    mkdirSync(join(dataDir, "slack", "C123ABC"), { recursive: true });
    writeFileSync(join(dataDir, "slack", "C123ABC", "MEMORY.md"), "channel");

    const result = formatMemory(dataDir, meta);
    expect(result).toContain("### Global Memory\nglobal");
    expect(result).toContain("### Transport Memory (slack)\ntransport");
    expect(result).toContain("### Channel Memory\nchannel");
  });

  test("omits empty files", () => {
    writeFileSync(join(dataDir, "MEMORY.md"), "   \n  ");
    mkdirSync(join(dataDir, "slack", "C123ABC"), { recursive: true });
    writeFileSync(join(dataDir, "slack", "C123ABC", "MEMORY.md"), "channel only");

    const result = formatMemory(dataDir, meta);
    expect(result).not.toContain("Global");
    expect(result).toBe("### Channel Memory\nchannel only");
  });

  test("handles encoded channel IDs", () => {
    const gchatMeta: ThreadMeta = {
      adapterName: "gchat",
      channelId: "spaces/ABC123",
      threadId: "t1",
      isDM: false,
    };
    // encode("spaces/ABC123") => "spaces%2FABC123"
    mkdirSync(join(dataDir, "gchat", "spaces%2FABC123"), { recursive: true });
    writeFileSync(join(dataDir, "gchat", "spaces%2FABC123", "MEMORY.md"), "gchat channel");

    const result = formatMemory(dataDir, gchatMeta);
    expect(result).toBe("### Channel Memory\ngchat channel");
  });
});
