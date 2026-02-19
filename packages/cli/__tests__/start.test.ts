import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";

const cliBin = join(import.meta.dir, "../src/bin.ts");

describe("guppy start", () => {
  test("errors when no start.ts exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guppy-cli-start-"));
    try {
      const result = await $`cd ${dir} && bun ${cliBin} start`
        .nothrow()
        .quiet();
      expect(result.exitCode).not.toBe(0);
      const stderr = result.stderr.toString();
      expect(stderr).toContain("No start.ts found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes --port as PORT env", async () => {
    // Write a start.ts that just prints PORT and exits
    const dir = await mkdtemp(join(tmpdir(), "guppy-cli-start-"));
    try {
      await Bun.write(
        join(dir, "start.ts"),
        `console.log("PORT=" + process.env.PORT); process.exit(0);`
      );

      const result = await $`cd ${dir} && bun ${cliBin} start --port 9999`.text();
      expect(result).toContain("PORT=9999");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
