import { describe, expect, test } from "bun:test";
import { getTransport, getAllTransports } from "../src/transports/registry";

describe("transport registry", () => {
  test("getAllTransports returns all 4 transports", () => {
    const all = getAllTransports();
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.id)).toEqual(["slack", "discord", "teams", "gchat"]);
  });

  test("getTransport returns correct transport by id", () => {
    const slack = getTransport("slack");
    expect(slack.displayName).toBe("Slack");
    expect(slack.adapterPackage).toBe("@chat-adapter/slack");
    expect(slack.adapterImport).toContain("createSlackAdapter");
    expect(slack.credentials.length).toBeGreaterThan(0);
  });

  test("discord has gateway code", () => {
    const discord = getTransport("discord");
    expect(discord.gatewayCode).toBeDefined();
    expect(discord.gatewayCode).toContain("startGatewayListener");
  });

  test("non-discord transports have no gateway code", () => {
    for (const id of ["slack", "teams", "gchat"] as const) {
      expect(getTransport(id).gatewayCode).toBeUndefined();
    }
  });

  test("throws on unknown transport", () => {
    // @ts-expect-error — testing runtime guard
    expect(() => getTransport("foobar")).toThrow("Unknown transport");
  });

  test("each transport has at least one credential", () => {
    for (const t of getAllTransports()) {
      expect(t.credentials.length).toBeGreaterThan(0);
    }
  });
});
