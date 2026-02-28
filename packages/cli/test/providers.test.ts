import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS, getProviderEnvVar } from "../src/providers";
import { getProviders, getModels } from "@mariozechner/pi-ai";
import type { KnownProvider } from "@mariozechner/pi-ai";

describe("SUPPORTED_PROVIDERS", () => {
  test("all supported providers exist in pi-ai", () => {
    const piProviders = getProviders();
    for (const sp of SUPPORTED_PROVIDERS) {
      expect(piProviders).toContain(sp.id);
    }
  });

  test("all supported providers have models in pi-ai", () => {
    for (const sp of SUPPORTED_PROVIDERS) {
      const models = getModels(sp.id as KnownProvider);
      expect(models.length).toBeGreaterThan(0);
    }
  });
});

describe("getProviderEnvVar", () => {
  test("returns known env vars", () => {
    expect(getProviderEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(getProviderEnvVar("openai")).toBe("OPENAI_API_KEY");
    expect(getProviderEnvVar("google")).toBe("GEMINI_API_KEY");
  });

  test("generates fallback for unknown providers", () => {
    expect(getProviderEnvVar("some-new-provider")).toBe("SOME_NEW_PROVIDER_API_KEY");
  });
});
