import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { scaffoldBlank, addTransport } from "../src/scaffold/engine";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "guppy-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scaffoldBlank", () => {
  test("creates expected file structure", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });

    const exists = (p: string) => Bun.file(join(projectDir, p)).exists();
    expect(await exists("src/index.ts")).toBe(true);
    expect(await exists("src/system-prompt.ts")).toBe(true);
    expect(await exists("src/inspect/index.ts")).toBe(true);
    expect(await exists("src/inspect/handler.ts")).toBe(true);
    expect(await exists("src/inspect/helpers.ts")).toBe(true);
    expect(await exists("src/inspect/styles.ts")).toBe(true);
    expect(await exists("src/inspect/stats.ts")).toBe(true);
    expect(await exists("src/inspect/tools.ts")).toBe(true);
    expect(await exists("src/inspect/messages.ts")).toBe(true);
    expect(await exists("data/IDENTITY.md")).toBe(true);
    expect(await exists("data/MEMORY.md")).toBe(true);
    expect(await exists("data/SYSTEM.md")).toBe(true);
    expect(await exists("package.json")).toBe(true);
    expect(await exists("tsconfig.json")).toBe(true);
    expect(await exists(".gitignore")).toBe(true);
    expect(await exists(".env")).toBe(true);
  });

  test("index.ts contains all three markers", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });

    const index = await Bun.file(join(projectDir, "src/index.ts")).text();
    expect(index).toContain("// @guppy:adapter-imports");
    expect(index).toContain("// @guppy:adapters");
    expect(index).toContain("// @guppy:gateway");
  });

  test("index.ts interpolates bot name", async () => {
    const projectDir = join(dir, "cool-bot");
    await scaffoldBlank({ name: "cool-bot", dir: projectDir, provider: "openai", modelId: "gpt-4o", deployTarget: "manual" });

    const index = await Bun.file(join(projectDir, "src/index.ts")).text();
    expect(index).toContain('"cool-bot"');
  });

  test("IDENTITY.md uses bot name", async () => {
    const projectDir = join(dir, "cool-bot");
    await scaffoldBlank({ name: "cool-bot", dir: projectDir, provider: "openai", modelId: "gpt-4o", deployTarget: "manual" });

    const identity = await Bun.file(join(projectDir, "data/IDENTITY.md")).text();
    expect(identity).toContain("cool-bot");
  });

  test("package.json has correct name and base deps", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });

    const pkg = await Bun.file(join(projectDir, "package.json")).json();
    expect(pkg.name).toBe("my-bot");
    expect(pkg.dependencies["@guppy/core"]).toBeDefined();
    expect(pkg.dependencies["chat"]).toBeDefined();
    expect(pkg.dependencies["@chat-adapter/state-memory"]).toBeDefined();
  });

  test(".env has provider API key and PORT", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", apiKey: "sk-test", deployTarget: "manual" });

    const env = await Bun.file(join(projectDir, ".env")).text();
    expect(env).toContain("ANTHROPIC_API_KEY=sk-test");
    expect(env).toContain("PORT=80");
  });

  test(".env uses correct env var for non-anthropic provider", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "openai", modelId: "gpt-4o", apiKey: "sk-openai", deployTarget: "manual" });

    const env = await Bun.file(join(projectDir, ".env")).text();
    expect(env).toContain("OPENAI_API_KEY=sk-openai");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
  });

  test("index.ts uses selected model", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "google", modelId: "gemini-2.5-flash", deployTarget: "manual" });

    const index = await Bun.file(join(projectDir, "src/index.ts")).text();
    expect(index).toContain('"google"');
    expect(index).toContain('"gemini-2.5-flash"');
  });

  test("system-prompt.ts matches demo verbatim", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });

    const scaffolded = await Bun.file(join(projectDir, "src/system-prompt.ts")).text();
    const demo = await Bun.file(
      join(import.meta.dir, "../../../apps/demo/src/system-prompt.ts"),
    ).text();
    expect(scaffolded).toBe(demo);
  });

  test("docker-compose target creates Dockerfile and compose file", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "docker-compose" });

    const exists = (p: string) => Bun.file(join(projectDir, p)).exists();
    expect(await exists("Dockerfile")).toBe(true);
    expect(await exists("docker-compose.yml")).toBe(true);
  });

  test("manual target creates no deploy files", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });

    const exists = (p: string) => Bun.file(join(projectDir, p)).exists();
    expect(await exists("Dockerfile")).toBe(false);
    expect(await exists("docker-compose.yml")).toBe(false);
    expect(await exists("fly.toml")).toBe(false);
    expect(await exists("railway.toml")).toBe(false);
  });
});

describe("addTransport", () => {
  test("injects slack import, adapter entry, and env vars", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });
    await addTransport(projectDir, "slack", {
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_SIGNING_SECRET: "secret",
    });

    const index = await Bun.file(join(projectDir, "src/index.ts")).text();
    expect(index).toContain('import { createSlackAdapter } from "@chat-adapter/slack"');
    expect(index).toContain("slack: createSlackAdapter(),");

    const env = await Bun.file(join(projectDir, ".env")).text();
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-test");
    expect(env).toContain("SLACK_SIGNING_SECRET=secret");

    const pkg = await Bun.file(join(projectDir, "package.json")).json();
    expect(pkg.dependencies["@chat-adapter/slack"]).toBe("^4.15.0");
  });

  test("injects discord with gateway code", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });
    await addTransport(projectDir, "discord", {
      DISCORD_BOT_TOKEN: "tok",
      DISCORD_PUBLIC_KEY: "key",
      DISCORD_APPLICATION_ID: "id",
    });

    const index = await Bun.file(join(projectDir, "src/index.ts")).text();
    expect(index).toContain('import { createDiscordAdapter } from "@chat-adapter/discord"');
    expect(index).toContain("discord: createDiscordAdapter(),");
    expect(index).toContain("startGatewayListener");
    expect(index).toContain('chat.getAdapter("discord")');
  });

  test("multiple transports can be added sequentially", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });
    await addTransport(projectDir, "slack", { SLACK_BOT_TOKEN: "t", SLACK_SIGNING_SECRET: "s" });
    await addTransport(projectDir, "discord", { DISCORD_BOT_TOKEN: "t", DISCORD_PUBLIC_KEY: "k", DISCORD_APPLICATION_ID: "i" });

    const index = await Bun.file(join(projectDir, "src/index.ts")).text();
    expect(index).toContain("slack: createSlackAdapter(),");
    expect(index).toContain("discord: createDiscordAdapter(),");

    const pkg = await Bun.file(join(projectDir, "package.json")).json();
    expect(pkg.dependencies["@chat-adapter/slack"]).toBeDefined();
    expect(pkg.dependencies["@chat-adapter/discord"]).toBeDefined();
  });

  test("markers survive after injection for future use", async () => {
    const projectDir = join(dir, "my-bot");
    await scaffoldBlank({ name: "my-bot", dir: projectDir, provider: "anthropic", modelId: "claude-sonnet-4-5", deployTarget: "manual" });
    await addTransport(projectDir, "slack", { SLACK_BOT_TOKEN: "t", SLACK_SIGNING_SECRET: "s" });

    const index = await Bun.file(join(projectDir, "src/index.ts")).text();
    expect(index).toContain("// @guppy:adapter-imports");
    expect(index).toContain("// @guppy:adapters");
    expect(index).toContain("// @guppy:gateway");
  });
});
