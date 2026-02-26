import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { channelDir } from "./encode";
import type { ThreadMeta } from "./types";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "global" | "transport" | "channel";
  disableModelInvocation: boolean;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

interface ParsedFrontmatter<T extends Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: {} as T, body: normalized };
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {} as T, body: normalized };
  }
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  const parsed = Bun.YAML.parse(yamlString);
  return { frontmatter: (parsed ?? {}) as T, body };
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function validateSkillName(name: string, parentDir: string): string | null {
  if (!name) return "missing name";
  if (name.length > 64) return "name exceeds 64 characters";
  if (!NAME_RE.test(name)) return "name must be lowercase a-z, 0-9, hyphens; no leading/trailing/consecutive hyphens";
  if (name.includes("--")) return "name must not contain consecutive hyphens";
  if (name !== parentDir) return `name "${name}" must match directory name "${parentDir}"`;
  return null;
}

function scanSkillsDir(
  skillsDir: string,
  source: Skill["source"],
): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const dir of entries) {
    const skillMdPath = join(skillsDir, dir, "SKILL.md");
    let content: string;
    try {
      content = readFileSync(skillMdPath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
    const name = frontmatter.name;
    const description = frontmatter.description;

    if (!name || !description?.trim()) continue;

    const err = validateSkillName(name, dir);
    if (err) continue;

    skills.push({
      name,
      description: description.trim(),
      filePath: skillMdPath,
      baseDir: join(skillsDir, dir),
      source,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    });
  }
  return skills;
}

export function loadSkills(dataDir: string, threadMeta: ThreadMeta): Skill[] {
  const chanDir = channelDir(dataDir, threadMeta.adapterName, threadMeta.channelKey);
  const scopes: Array<{ dir: string; source: Skill["source"] }> = [
    { dir: join(dataDir, "skills"), source: "global" },
    { dir: join(dataDir, threadMeta.adapterName, "skills"), source: "transport" },
    { dir: join(chanDir, "skills"), source: "channel" },
  ];

  const byName = new Map<string, Skill>();
  for (const { dir, source } of scopes) {
    for (const skill of scanSkillsDir(dir, source)) {
      byName.set(skill.name, skill); // narrower scope overrides
    }
  }
  return [...byName.values()];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";

  const entries = visible
    .map(
      (s) =>
        `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.filePath)}</location>\n  </skill>`,
    )
    .join("\n");

  return `The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
${entries}
</available_skills>`;
}
