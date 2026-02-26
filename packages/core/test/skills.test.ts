import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills, formatSkillsForPrompt } from "../src/skills";
import type { Skill } from "../src/skills";
import type { ChannelKey, ThreadKey } from "../src/encode";
import type { ThreadMeta } from "../src/types";

let dataDir: string;

const meta: ThreadMeta = {
  adapterName: "slack",
  channelId: "slack:C123",
  threadId: "slack:C123:t1",
  channelKey: "C123" as ChannelKey,
  threadKey: "t1" as ThreadKey,
  isDM: false,
};

function writeSkill(dir: string, name: string, opts?: { description?: string; disable?: boolean }) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const desc = opts?.description ?? `Does ${name} things`;
  const disable = opts?.disable ? "\ndisable-model-invocation: true" : "";
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${desc}${disable}\n---\n\n# ${name}\nUsage.`,
  );
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "guppy-skills-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("loadSkills", () => {
  test("returns empty array when no skills dirs exist", () => {
    expect(loadSkills(dataDir, meta)).toEqual([]);
  });

  test("discovers global skills", () => {
    writeSkill(join(dataDir, "skills"), "my-tool");
    const skills = loadSkills(dataDir, meta);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-tool");
    expect(skills[0].source).toBe("global");
  });

  test("discovers transport skills", () => {
    writeSkill(join(dataDir, "slack", "skills"), "slack-tool");
    const skills = loadSkills(dataDir, meta);
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe("transport");
  });

  test("discovers channel skills", () => {
    writeSkill(join(dataDir, "slack", "C123", "skills"), "chan-tool");
    const skills = loadSkills(dataDir, meta);
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe("channel");
  });

  test("discovers skills from all 3 scopes", () => {
    writeSkill(join(dataDir, "skills"), "global-tool");
    writeSkill(join(dataDir, "slack", "skills"), "transport-tool");
    writeSkill(join(dataDir, "slack", "C123", "skills"), "channel-tool");
    const skills = loadSkills(dataDir, meta);
    expect(skills).toHaveLength(3);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["channel-tool", "global-tool", "transport-tool"]);
  });

  test("narrower scope overrides broader by name", () => {
    writeSkill(join(dataDir, "skills"), "my-tool", { description: "global version" });
    writeSkill(join(dataDir, "slack", "C123", "skills"), "my-tool", { description: "channel version" });
    const skills = loadSkills(dataDir, meta);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("channel version");
    expect(skills[0].source).toBe("channel");
  });

  test("rejects names with uppercase", () => {
    writeSkill(join(dataDir, "skills"), "MyTool");
    // name won't match the regex
    const skills = loadSkills(dataDir, meta);
    expect(skills).toHaveLength(0);
  });

  test("rejects names with leading hyphen", () => {
    const dir = join(dataDir, "skills", "-bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: -bad\ndescription: test\n---\n");
    expect(loadSkills(dataDir, meta)).toHaveLength(0);
  });

  test("rejects names with consecutive hyphens", () => {
    const dir = join(dataDir, "skills", "a--b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: a--b\ndescription: test\n---\n");
    expect(loadSkills(dataDir, meta)).toHaveLength(0);
  });

  test("rejects name that doesn't match directory", () => {
    const dir = join(dataDir, "skills", "my-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: other-name\ndescription: test\n---\n");
    expect(loadSkills(dataDir, meta)).toHaveLength(0);
  });

  test("rejects names longer than 64 chars", () => {
    const longName = "a".repeat(65);
    const dir = join(dataDir, "skills", longName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${longName}\ndescription: test\n---\n`);
    expect(loadSkills(dataDir, meta)).toHaveLength(0);
  });

  test("skips skills without description", () => {
    const dir = join(dataDir, "skills", "nodesc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: nodesc\n---\n");
    expect(loadSkills(dataDir, meta)).toHaveLength(0);
  });

  test("skips directories without SKILL.md", () => {
    mkdirSync(join(dataDir, "skills", "empty-dir"), { recursive: true });
    expect(loadSkills(dataDir, meta)).toHaveLength(0);
  });

  test("reads disable-model-invocation flag", () => {
    writeSkill(join(dataDir, "skills"), "hidden", { disable: true });
    const skills = loadSkills(dataDir, meta);
    expect(skills).toHaveLength(1);
    expect(skills[0].disableModelInvocation).toBe(true);
  });

  test("handles missing dirs gracefully", () => {
    // No dirs created at all — should not throw
    expect(() => loadSkills(dataDir, meta)).not.toThrow();
  });
});

describe("formatSkillsForPrompt", () => {
  test("returns empty string when no skills", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  test("returns XML block with skill entries", () => {
    const skills: Skill[] = [
      {
        name: "email",
        description: "Send emails",
        filePath: "/data/skills/email/SKILL.md",
        baseDir: "/data/skills/email",
        source: "global",
        disableModelInvocation: false,
      },
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("<available_skills>");
    expect(result).toContain("<name>email</name>");
    expect(result).toContain("<description>Send emails</description>");
    expect(result).toContain("<location>/data/skills/email/SKILL.md</location>");
    expect(result).toContain("</available_skills>");
  });

  test("filters out disableModelInvocation skills", () => {
    const skills: Skill[] = [
      {
        name: "visible",
        description: "Visible skill",
        filePath: "/a",
        baseDir: "/a",
        source: "global",
        disableModelInvocation: false,
      },
      {
        name: "hidden",
        description: "Hidden skill",
        filePath: "/b",
        baseDir: "/b",
        source: "global",
        disableModelInvocation: true,
      },
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("visible");
    expect(result).not.toContain("hidden");
  });

  test("returns empty string when all skills are hidden", () => {
    const skills: Skill[] = [
      {
        name: "hidden",
        description: "Hidden",
        filePath: "/a",
        baseDir: "/a",
        source: "global",
        disableModelInvocation: true,
      },
    ];
    expect(formatSkillsForPrompt(skills)).toBe("");
  });

  test("escapes XML special characters", () => {
    const skills: Skill[] = [
      {
        name: "test",
        description: 'Uses <tags> & "quotes"',
        filePath: "/a",
        baseDir: "/a",
        source: "global",
        disableModelInvocation: false,
      },
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("&lt;tags&gt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;quotes&quot;");
  });
});
