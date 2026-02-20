import { test, expect, describe } from "bun:test";
import { getModel, completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { agentLoop, type AgentTool, type AgentContext, type AgentLoopConfig } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { openDatabase } from "../db/schema.ts";
import { getOrCreateThread } from "../db/threads.ts";
import { insertMessage, getContext } from "../db/messages.ts";
import { convertToLlm } from "../agent/convert.ts";
import { createReadTool, createWriteTool, createEditTool, createBashTool } from "@guppy/core";
import { resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const WORKSPACE = resolve(import.meta.dir, "../workspace-test");
const DB_PATH = resolve(import.meta.dir, "../test-data.sqlite");

function setup() {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  rmSync(DB_PATH, { force: true });
  return openDatabase(DB_PATH);
}

describe("Bun compatibility", () => {
  test("pi-ai imports work", () => {
    expect(getModel).toBeFunction();
    expect(completeSimple).toBeFunction();
    expect(getEnvApiKey).toBeFunction();
  });

  test("agentLoop imports work", () => {
    expect(agentLoop).toBeFunction();
  });

  test("getModel returns a model object", () => {
    const model = getModel("anthropic", "claude-sonnet-4-5");
    expect(model.id).toContain("claude");
    expect(model.provider).toBe("anthropic");
  });

  test("TypeBox schema creation works", () => {
    const schema = Type.Object({
      path: Type.String(),
      content: Type.Optional(Type.String()),
    });
    expect(schema.type).toBe("object");
    expect(schema.properties.path.type).toBe("string");
  });
});

describe("SQLite persistence", () => {
  test("schema creation + thread CRUD", () => {
    const db = setup();
    const thread = getOrCreateThread(db, "cli", "test-channel");
    expect(thread.id).toBeTruthy();
    expect(thread.transport).toBe("cli");
    expect(thread.channel_id).toBe("test-channel");

    // Getting same thread again returns same ID
    const same = getOrCreateThread(db, "cli", "test-channel");
    expect(same.id).toBe(thread.id);
    db.close();
  });

  test("message tree + CTE context assembly", () => {
    const db = setup();
    const thread = getOrCreateThread(db, "cli", "ctx-test");

    const m1 = insertMessage(db, thread.id, null, "user", "Hello");
    const m2 = insertMessage(db, thread.id, m1.id, "assistant", { role: "assistant", content: [{ type: "text", text: "Hi!" }], timestamp: Date.now() });
    const m3 = insertMessage(db, thread.id, m2.id, "user", "How are you?");

    const ctx = getContext(db, m3.id);
    expect(ctx).toHaveLength(3);
    expect(ctx[0]!.role).toBe("user");
    expect(ctx[2]!.role).toBe("user");
    db.close();
  });

  test("summary stops CTE walk", () => {
    const db = setup();
    const thread = getOrCreateThread(db, "cli", "summary-test");

    const m1 = insertMessage(db, thread.id, null, "user", "old message 1");
    const m2 = insertMessage(db, thread.id, m1.id, "assistant", "old response");
    const m3 = insertMessage(db, thread.id, m2.id, "summary", "Summary of previous conversation");
    const m4 = insertMessage(db, thread.id, m3.id, "user", "new message");

    const ctx = getContext(db, m4.id);
    // Should include summary + new message, but NOT m1 or m2
    expect(ctx).toHaveLength(2);
    expect(ctx[0]!.role).toBe("summary");
    expect(ctx[1]!.role).toBe("user");
    db.close();
  });
});

describe("Tools", () => {
  test("read tool reads files", async () => {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(resolve(WORKSPACE, "test.txt"), "line1\nline2\nline3\n");

    const tool = createReadTool(WORKSPACE);
    const result = await tool.execute("tc1", { path: "test.txt" });
    expect(result.content[0]!.type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("line1");
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("line2");
  });

  test("write tool creates files", async () => {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });

    const tool = createWriteTool(WORKSPACE);
    await tool.execute("tc2", { path: "sub/new.txt", content: "hello" });

    const content = await Bun.file(resolve(WORKSPACE, "sub/new.txt")).text();
    expect(content).toBe("hello");
  });

  test("edit tool replaces strings", async () => {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(resolve(WORKSPACE, "edit.txt"), "Hello World");

    const tool = createEditTool(WORKSPACE);
    await tool.execute("tc3", { path: "edit.txt", old_string: "World", new_string: "Guppy" });

    const content = await Bun.file(resolve(WORKSPACE, "edit.txt")).text();
    expect(content).toBe("Hello Guppy");
  });

  test("edit tool rejects non-unique matches", async () => {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(resolve(WORKSPACE, "dup.txt"), "aaa bbb aaa");

    const tool = createEditTool(WORKSPACE);
    const result = await tool.execute("tc4", { path: "dup.txt", old_string: "aaa", new_string: "ccc" });
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("2 times");
  });

  test("bash tool runs commands", async () => {
    const tool = createBashTool(WORKSPACE);
    const result = await tool.execute("tc5", { command: "echo hello" });
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("hello");
  });

  test("path escape is rejected", () => {
    const tool = createReadTool(WORKSPACE);
    expect(tool.execute("tc6", { path: "../../etc/passwd" })).rejects.toThrow("escapes workspace");
  });
});

describe("LLM integration", () => {
  const hasKey = !!getEnvApiKey("anthropic");

  test.skipIf(!hasKey)("completeSimple returns a response", async () => {
    const model = getModel("anthropic", "claude-sonnet-4-5");
    const response = await completeSimple(model, {
      systemPrompt: "Reply with just 'ok'",
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
    });
    expect(response.role).toBe("assistant");
    expect(response.content.length).toBeGreaterThan(0);
  }, 30_000);

  test.skipIf(!hasKey)("agentLoop with tools completes a round trip", async () => {
    rmSync(WORKSPACE, { recursive: true, force: true });
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(resolve(WORKSPACE, "hello.txt"), "Hello from test!");

    const model = getModel("anthropic", "claude-sonnet-4-5");
    const tools = [createReadTool(WORKSPACE)];

    const context: AgentContext = {
      systemPrompt: "Read the file hello.txt and tell me its contents. Be brief.",
      messages: [],
      tools,
    };

    const config: AgentLoopConfig = {
      model,
      convertToLlm,
      getApiKey: (provider) => getEnvApiKey(provider),
    };

    const prompt = { role: "user" as const, content: "Read hello.txt", timestamp: Date.now() };
    const stream = agentLoop([prompt], context, config);

    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }

    const result = await stream.result();

    // Should have gone through agent_start, tool execution, agent_end
    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
    expect(events).toContain("tool_execution_start");

    // Result should contain assistant message with file contents
    const assistantMsgs = result.filter((m) => (m as any).role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
  }, 60_000);
});
