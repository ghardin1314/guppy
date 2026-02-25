import { describe, expect, test } from "bun:test";
import { encode, decode, parseThreadId } from "../src/encode";

describe("encode", () => {
  test("passes safe strings through unchanged", () => {
    expect(encode("C123ABC")).toBe("C123ABC");
    expect(encode("1234567890.123456")).toBe("1234567890.123456");
  });

  test("encodes forward slashes", () => {
    expect(encode("spaces/ABC123")).toBe("spaces%2FABC123");
  });

  test("encodes backslashes", () => {
    expect(encode("foo\\bar")).toBe("foo%5Cbar");
  });

  test("encodes colons", () => {
    expect(encode("a:b")).toBe("a%3Ab");
  });

  test("encodes percent signs", () => {
    expect(encode("100%")).toBe("100%25");
  });

  test("encodes all unsafe chars", () => {
    const result = encode('a/b\\c:d*e?f"g<h>i|j%k');
    expect(result).not.toMatch(/[/\\:*?"<>|%](?![0-9A-F]{2})/);
  });
});

describe("decode", () => {
  test("decodes percent-encoded strings", () => {
    expect(decode("spaces%2FABC123")).toBe("spaces/ABC123");
    expect(decode("foo%5Cbar")).toBe("foo\\bar");
  });

  test("round-trips with encode", () => {
    const inputs = [
      "spaces/ABC123",
      "foo\\bar",
      "a:b:c",
      'file"name',
      "100%done",
      "C123ABC",
    ];
    for (const input of inputs) {
      expect(decode(encode(input))).toBe(input);
    }
  });
});

describe("parseThreadId", () => {
  test("splits standard slack thread ID", () => {
    const result = parseThreadId("slack:C123ABC:1234567890.123456");
    expect(result).toEqual({
      adapter: "slack",
      channelId: "C123ABC",
      threadId: "1234567890.123456",
    });
  });

  test("handles colons in third segment", () => {
    const result = parseThreadId("gchat:spaces/ABC123:thread:with:colons");
    expect(result).toEqual({
      adapter: "gchat",
      channelId: "spaces/ABC123",
      threadId: "thread:with:colons",
    });
  });

  test("throws on missing colons", () => {
    expect(() => parseThreadId("nocolons")).toThrow("found no colons");
    expect(() => parseThreadId("one:colon")).toThrow("found only one colon");
  });
});
