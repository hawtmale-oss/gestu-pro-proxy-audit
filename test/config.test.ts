import { describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import {
  hasFreeUpstreamKey,
  hasProUpstreamKey,
  readConfig,
  readFreeRateLimiter,
  readFreeUpstreamApiKey,
  readUpstreamApiKey,
} from "../src/config";

/**
 * Configuration seams.
 *
 * The important properties are: the defaults point at the real managed upstreams, the legacy
 * `DEEPSEEK_*` names still work for an older deployment, the newer `UPSTREAM_*` names win when both
 * are set, and the public gateway is `https://api.gestu.ca` (`…/v1`), which is what the Kotlin
 * client is compiled against.
 */
function env(overrides: Partial<Env> = {}): Env {
  return { GESTU_ALLOWED_PACKAGE_NAMES: "com.gestu.app", ...overrides } as Env;
}

describe("readConfig upstreams", () => {
  it("defaults both managed routes to the DeepSeek Direct API", () => {
    const config = readConfig(env());
    expect(config.proUpstreamBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.proUpstreamModelId).toBe("deepseek-flash");
    // Free and Pro are the same provider, same model; only the credential and tier caps differ.
    expect(config.freeUpstreamBaseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.freeUpstreamModelId).toBe("deepseek-flash");
    // No trailing slash: the proxy appends /chat/completions itself.
    expect(config.proUpstreamBaseUrl.endsWith("/")).toBe(false);
    expect(config.freeUpstreamBaseUrl.endsWith("/")).toBe(false);
  });

  it("supports the legacy DEEPSEEK_* aliases when UPSTREAM_* is unset", () => {
    const config = readConfig(
      env({
        DEEPSEEK_BASE_URL: "https://legacy.example.test/v1/",
        DEEPSEEK_CHAT_MODEL: "legacy-model",
      }),
    );
    expect(config.proUpstreamBaseUrl).toBe("https://legacy.example.test/v1");
    expect(config.proUpstreamModelId).toBe("legacy-model");
  });

  it("lets UPSTREAM_* take precedence over the legacy aliases", () => {
    const config = readConfig(
      env({
        UPSTREAM_BASE_URL: "https://primary.example.test/",
        UPSTREAM_MODEL_ID: "primary-model",
        DEEPSEEK_BASE_URL: "https://legacy.example.test",
        DEEPSEEK_CHAT_MODEL: "legacy-model",
      }),
    );
    expect(config.proUpstreamBaseUrl).toBe("https://primary.example.test");
    expect(config.proUpstreamModelId).toBe("primary-model");
  });

  it("lets an operator override the Free upstream without a code change", () => {
    const config = readConfig(
      env({
        FREE_UPSTREAM_BASE_URL: "https://free.example.test/v1beta/openai/",
        FREE_UPSTREAM_MODEL_ID: "some-free-model",
      }),
    );
    expect(config.freeUpstreamBaseUrl).toBe("https://free.example.test/v1beta/openai");
    expect(config.freeUpstreamModelId).toBe("some-free-model");
  });
});

describe("readConfig public URLs and quotas", () => {
  it("defaults to the api.gestu.ca gateway the app is compiled against", () => {
    const config = readConfig(env());
    expect(config.publicBaseUrl).toBe("https://api.gestu.ca");
    expect(config.proxyBaseUrl).toBe("https://api.gestu.ca/v1");
  });

  it("keeps the locked quota constants as the defaults", () => {
    const config = readConfig(env());
    expect(config.monthlyTokenLimit).toBe(101_500_000);
    expect(config.freeMonthlyOutputTokenLimit).toBe(200_000);
    // The old three-tier 300,000,000 must not come back.
    expect(config.monthlyTokenLimit).not.toBe(300_000_000);
  });
});

describe("upstream credentials", () => {
  it("prefers each tier's own key when both are configured", () => {
    const both = env({ DEEPSEEK_API_KEY: "pro-key", GEMINI_FREE_API_KEY: "free-key" });
    expect(readUpstreamApiKey(both)).toBe("pro-key");
    expect(readFreeUpstreamApiKey(both)).toBe("free-key");
    expect(hasProUpstreamKey(both)).toBe(true);
    expect(hasFreeUpstreamKey(both)).toBe(true);
  });

  it("lets one DeepSeek Direct key serve both tiers", () => {
    // The managed Worker holds a single upstream credential; the Free route reuses it rather than
    // requiring a second secret. A dedicated Free key still wins when it is set.
    const shared = env({ DEEPSEEK_API_KEY: "shared-key" });
    expect(readUpstreamApiKey(shared)).toBe("shared-key");
    expect(readFreeUpstreamApiKey(shared)).toBe("shared-key");
    expect(hasFreeUpstreamKey(shared)).toBe(true);

    const dedicated = env({ DEEPSEEK_API_KEY: "shared-key", DEEPSEEK_FREE_API_KEY: "free-only-key" });
    expect(readFreeUpstreamApiKey(dedicated)).toBe("free-only-key");
  });

  it("fails closed when a key is absent", () => {
    expect(hasProUpstreamKey(env())).toBe(false);
    expect(hasFreeUpstreamKey(env())).toBe(false);
    expect(readUpstreamApiKey(env())).toBe("");
    expect(readFreeUpstreamApiKey(env())).toBe("");
  });

  it("accepts the generic UPSTREAM_API_KEY alias for Pro", () => {
    expect(readUpstreamApiKey(env({ UPSTREAM_API_KEY: "generic" }))).toBe("generic");
    // The specific UPSTREAM_API_KEY wins if both are set.
    expect(readUpstreamApiKey(env({ UPSTREAM_API_KEY: "generic", DEEPSEEK_API_KEY: "legacy" }))).toBe("generic");
  });
});

describe("Free rate limiter binding", () => {
  it("is optional and read structurally", () => {
    expect(readFreeRateLimiter(env())).toBeUndefined();
    const binding = {
      limit: async (): Promise<{ success: boolean }> => ({ success: true }),
    };
    expect(readFreeRateLimiter(env({ FREE_RATE_LIMITER: binding }))).toBe(binding);
  });
});
