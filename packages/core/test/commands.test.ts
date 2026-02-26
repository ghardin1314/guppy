import { describe, expect, test } from "bun:test";
import { parseCommand, commandToMessage, BUILT_IN_COMMANDS } from "../src/commands";

describe("parseCommand", () => {
  test("parses /stop", () => {
    expect(parseCommand("/stop")).toEqual({ command: "stop", args: "" });
  });

  test("parses command with args", () => {
    expect(parseCommand("/steer fix the bug")).toEqual({
      command: "steer",
      args: "fix the bug",
    });
  });

  test("trims leading whitespace", () => {
    expect(parseCommand("  /stop")).toEqual({ command: "stop", args: "" });
  });

  test("trims args", () => {
    expect(parseCommand("/cmd   spaced  ")).toEqual({
      command: "cmd",
      args: "spaced",
    });
  });

  test("returns null for regular text", () => {
    expect(parseCommand("hello world")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseCommand("")).toBeNull();
  });

  test("returns null for text starting with / but containing earlier text", () => {
    expect(parseCommand("hey /stop")).toBeNull();
  });

  test("handles multiline args", () => {
    const result = parseCommand("/cmd line1\nline2");
    expect(result).toEqual({ command: "cmd", args: "line1\nline2" });
  });
});

describe("commandToMessage", () => {
  test("/stop maps to abort", () => {
    expect(commandToMessage("stop", "")).toEqual({ type: "abort" });
  });

  test("strips leading / from command", () => {
    expect(commandToMessage("/stop", "")).toEqual({ type: "abort" });
  });

  test("unknown command returns null", () => {
    expect(commandToMessage("unknown", "")).toBeNull();
  });
});

describe("BUILT_IN_COMMANDS", () => {
  test("includes stop", () => {
    expect(BUILT_IN_COMMANDS.some((c) => c.name === "stop")).toBe(true);
  });
});
