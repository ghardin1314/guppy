import { describe, expect, test } from "bun:test";
import { generateIndexTs } from "../src/scaffold/templates/index-ts";
import { generateIdentityMd } from "../src/scaffold/templates/data";
import { generatePackageJson, generateEnv, TSCONFIG_JSON, GITIGNORE } from "../src/scaffold/templates/project";
import { getDeployFiles } from "../src/scaffold/templates/deploy";
import { getStaticFiles } from "../src/scaffold/templates/static";

const defaultOpts = { botName: "test-bot", provider: "anthropic", modelId: "claude-sonnet-4-5" };

describe("generateIndexTs", () => {
  test("contains all three markers", () => {
    const result = generateIndexTs(defaultOpts);
    expect(result).toContain("// @guppy:adapter-imports");
    expect(result).toContain("// @guppy:adapters");
    expect(result).toContain("// @guppy:gateway");
  });

  test("interpolates bot name into BOT_NAME", () => {
    const result = generateIndexTs({ ...defaultOpts, botName: "my-cool-bot" });
    expect(result).toContain('"my-cool-bot"');
  });

  test("has no transport-specific imports", () => {
    const result = generateIndexTs(defaultOpts);
    expect(result).not.toContain("@chat-adapter/slack");
    expect(result).not.toContain("@chat-adapter/discord");
  });

  test("includes core imports and structure", () => {
    const result = generateIndexTs(defaultOpts);
    expect(result).toContain("@guppy/core");
    expect(result).toContain("new Chat");
    expect(result).toContain("new Guppy");
    expect(result).toContain("Bun.serve");
    expect(result).toContain("chat.initialize");
  });

  test("uses selected provider and model", () => {
    const result = generateIndexTs({ botName: "bot", provider: "openai", modelId: "gpt-4o" });
    expect(result).toContain('getModel("openai", "gpt-4o")');
  });
});

describe("generateIdentityMd", () => {
  test("includes bot name", () => {
    expect(generateIdentityMd("my-bot")).toContain("my-bot");
  });
});

describe("generatePackageJson", () => {
  test("includes name and base deps", async () => {
    const raw = await generatePackageJson("my-bot");
    const pkg = JSON.parse(raw);
    expect(pkg.name).toBe("my-bot");
    expect(pkg.dependencies["@guppy/core"]).toBeDefined();
    expect(pkg.dependencies["chat"]).toBeDefined();
  });

  test("merges extra deps and sorts", async () => {
    const raw = await generatePackageJson("my-bot", { "zzz-lib": "^1.0.0" });
    const pkg = JSON.parse(raw);
    expect(pkg.dependencies["zzz-lib"]).toBe("^1.0.0");
    const keys = Object.keys(pkg.dependencies);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("generateEnv", () => {
  test("defaults PORT", () => {
    const env = generateEnv();
    expect(env).toContain("PORT=80");
  });

  test("includes provider API key entries", () => {
    const env = generateEnv({ OPENAI_API_KEY: "sk-test" });
    expect(env).toContain("OPENAI_API_KEY=sk-test");
  });

  test("includes transport credential entries", () => {
    const env = generateEnv({ SLACK_BOT_TOKEN: "xoxb-test" });
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-test");
  });
});

describe("TSCONFIG_JSON", () => {
  test("is valid JSON with expected fields", () => {
    const parsed = JSON.parse(TSCONFIG_JSON);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(parsed.compilerOptions.noEmit).toBe(true);
  });
});

describe("getDeployFiles", () => {
  test("manual returns no files", () => {
    expect(getDeployFiles("manual", "bot")).toHaveLength(0);
  });

  test("docker-compose returns Dockerfile and compose", () => {
    const files = getDeployFiles("docker-compose", "bot");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("docker-compose.yml");
  });

  test("systemd returns service file with bot name", () => {
    const files = getDeployFiles("systemd", "my-bot");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("my-bot.service");
    expect(files[0].content).toContain("my-bot");
  });

  test("railway returns Dockerfile and railway.toml", () => {
    const paths = getDeployFiles("railway", "bot").map((f) => f.path);
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("railway.toml");
  });

  test("fly returns Dockerfile and fly.toml with app name", () => {
    const files = getDeployFiles("fly", "my-bot");
    const paths = files.map((f) => f.path);
    expect(paths).toContain("Dockerfile");
    expect(paths).toContain("fly.toml");
    const flyToml = files.find((f) => f.path === "fly.toml")!;
    expect(flyToml.content).toContain('app = "my-bot"');
  });
});

describe("getStaticFiles", () => {
  test("returns all 8 static files", async () => {
    const files = await getStaticFiles();
    const paths = Object.keys(files);
    expect(paths).toHaveLength(8);
    expect(paths).toContain("src/system-prompt.ts");
    expect(paths).toContain("src/inspect/index.ts");
    expect(paths).toContain("src/inspect/handler.ts");
    expect(paths).toContain("src/inspect/helpers.ts");
    expect(paths).toContain("src/inspect/styles.ts");
    expect(paths).toContain("src/inspect/stats.ts");
    expect(paths).toContain("src/inspect/tools.ts");
    expect(paths).toContain("src/inspect/messages.ts");
  });

  test("files are non-empty", async () => {
    const files = await getStaticFiles();
    for (const [path, content] of Object.entries(files)) {
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
