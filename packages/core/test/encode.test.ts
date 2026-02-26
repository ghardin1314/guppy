import { describe, expect, test } from "bun:test";
import { encode, decode, adapterNameFrom, resolveThreadKeys, type ChannelKey, type ThreadKey } from "../src/encode";

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

describe("adapterNameFrom", () => {
  test("extracts adapter name", () => {
    expect(adapterNameFrom("slack:C123ABC:1234567890.123456")).toBe("slack");
  });

  test("throws on missing colon", () => {
    expect(() => adapterNameFrom("nocolons")).toThrow("no colon found");
  });
});

describe("resolveThreadKeys", () => {
  const slackAdapter = { name: "slack" };
  const gchatAdapter = { name: "gchat" };

  test("splits standard slack thread ID (default 2-segment channel)", () => {
    const result = resolveThreadKeys(slackAdapter, "slack:C123ABC:1234567890.123456");
    expect(result).toEqual({
      adapter: "slack",
      channelKey: "C123ABC" as ChannelKey,
      threadKey: "1234567890.123456" as ThreadKey,
    });
  });

  test("handles colons in thread segment", () => {
    const result = resolveThreadKeys(gchatAdapter, "gchat:spaces/ABC123:thread:with:colons");
    expect(result).toEqual({
      adapter: "gchat",
      channelKey: "spaces/ABC123" as ChannelKey,
      threadKey: "thread:with:colons" as ThreadKey,
    });
  });

  test("uses adapter.channelIdFromThreadId when provided (Discord 4-segment)", () => {
    const discordAdapter = {
      name: "discord",
      channelIdFromThreadId: (id: string) => id.split(":").slice(0, 3).join(":"),
    };
    const result = resolveThreadKeys(discordAdapter, "discord:guild1:chan1:thread1");
    expect(result).toEqual({
      adapter: "discord",
      channelKey: "guild1:chan1" as ChannelKey,
      threadKey: "thread1" as ThreadKey,
    });
  });
});
