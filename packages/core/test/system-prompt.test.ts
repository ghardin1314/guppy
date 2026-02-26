import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSystemPrompt, loadIdentity } from "../src/system-prompt";
import type { Sandbox } from "../src/sandbox";
import type { ChannelKey, ThreadKey } from "../src/encode";
import type { Settings, ThreadMeta } from "../src/types";

let dataDir: string;

const meta: ThreadMeta = {
  adapterName: "slack",
  channelId: "slack:C123",
  threadId: "slack:C123:t1",
  channelKey: "C123" as ChannelKey,
  threadKey: "t1" as ThreadKey,
  isDM: false,
};

const settings: Settings = {};

function hostSandbox(): Sandbox {
  return {
    type: "host",
    workspacePath: "/workspace",
    exec: () => Promise.resolve({ output: "", exitCode: 0, timedOut: false, truncated: false }),
  };
}

function dockerSandbox(): Sandbox {
  return {
    type: "docker",
    workspacePath: "/",
    exec: () => Promise.resolve({ output: "", exitCode: 0, timedOut: false, truncated: false }),
  };
}

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
    expect(loadIdentity(dataDir)).toBe("You are a chat assistant. Be concise. No emojis.");
  });

  test("returns default when file is empty", () => {
    writeFileSync(join(dataDir, "IDENTITY.md"), "   ");
    expect(loadIdentity(dataDir)).toBe("You are a chat assistant. Be concise. No emojis.");
  });
});

describe("buildSystemPrompt", () => {
  test("assembles full prompt with all sections", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "You are TestBot.",
      memory: "(no memory yet)",
      skills: [],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });

    // Identity at top
    expect(result.startsWith("You are TestBot.")).toBe(true);

    // All major sections present
    expect(result).toContain("## Context");
    expect(result).toContain("## Formatting");
    expect(result).toContain("## Mentions");
    expect(result).toContain("## Environment");
    expect(result).toContain("## Workspace Layout");
    expect(result).toContain("## Skills (Custom CLI Tools)");
    expect(result).toContain("## Events");
    expect(result).toContain("## Memory");
    expect(result).toContain("## System Configuration Log");
    expect(result).toContain("## History Search");
    expect(result).toContain("## Tools");
  });

  test("substitutes dataDir in paths", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "(no memory yet)",
      skills: [],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain(`${dataDir}/`);
    expect(result).toContain(`${dataDir}/events/`);
  });

  test("substitutes adapter and channel/thread IDs", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "(no memory yet)",
      skills: [],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain("slack/");
    expect(result).toContain("C123/");
  });

  test("host sandbox environment description", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "(no memory yet)",
      skills: [],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain("running directly on the host machine");
    expect(result).toContain("Be careful with system modifications");
  });

  test("docker sandbox environment description", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "(no memory yet)",
      skills: [],
      sandbox: dockerSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain("Docker container");
    expect(result).toContain("apk add");
  });

  test("uses '(no skills installed yet)' fallback", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "(no memory yet)",
      skills: [],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain("(no skills installed yet)");
  });

  test("includes formatted skills when provided", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "(no memory yet)",
      skills: [
        {
          name: "email",
          description: "Send emails",
          filePath: "/data/skills/email/SKILL.md",
          baseDir: "/data/skills/email",
          source: "global",
          disableModelInvocation: false,
        },
      ],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<name>email</name>");
    expect(result).not.toContain("(no skills installed yet)");
  });

  test("includes memory content", () => {
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "### Global Memory\nRemember to be nice",
      skills: [],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain("### Global Memory\nRemember to be nice");
  });

  test("includes timezone", () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = buildSystemPrompt({
      dataDir,
      identity: "Bot",
      memory: "(no memory yet)",
      skills: [],
      sandbox: hostSandbox(),
      settings,
      threadMeta: meta,
    });
    expect(result).toContain(tz);
  });
});
