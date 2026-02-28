import { describe, expect, test } from "bun:test";
import { insertAtMarker } from "../src/scaffold/markers";

describe("insertAtMarker", () => {
  test("inserts code before the marker line", () => {
    const content = `line1\n    // @guppy:adapters\nline3`;
    const result = insertAtMarker(content, "adapters", "    slack: createSlackAdapter(),");
    expect(result).toBe(
      `line1\n    slack: createSlackAdapter(),\n    // @guppy:adapters\nline3`,
    );
  });

  test("inserts at marker on first line", () => {
    const content = `// @guppy:adapter-imports\nimport foo from "foo";`;
    const result = insertAtMarker(content, "adapter-imports", 'import bar from "bar";');
    expect(result).toBe(
      `import bar from "bar";\n// @guppy:adapter-imports\nimport foo from "foo";`,
    );
  });

  test("supports multi-line code insertion", () => {
    const content = `before\n// @guppy:gateway\nafter`;
    const code = `const a = 1;\nconst b = 2;`;
    const result = insertAtMarker(content, "gateway", code);
    expect(result).toBe(`before\nconst a = 1;\nconst b = 2;\n// @guppy:gateway\nafter`);
  });

  test("preserves multiple markers independently", () => {
    const content = `// @guppy:imports\n// @guppy:adapters\n// @guppy:gateway`;
    const r1 = insertAtMarker(content, "adapters", "adapter-line");
    expect(r1).toContain("// @guppy:imports");
    expect(r1).toContain("adapter-line\n// @guppy:adapters");
    expect(r1).toContain("// @guppy:gateway");
  });

  test("throws when marker is missing", () => {
    expect(() => insertAtMarker("no markers here", "adapters", "code")).toThrow(
      'Marker "// @guppy:adapters" not found',
    );
  });
});
