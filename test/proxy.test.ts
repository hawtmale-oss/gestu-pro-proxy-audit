import { describe, expect, it, vi } from "vitest";
import { mintVirtualKey, sha256Hex } from "../src/base64";
import {
  FREE_CHAT_RATE_LIMIT,
  FREE_MANAGED_MODEL_ALIAS,
  FREE_MANAGED_MODEL_ID,
  FREE_MAX_COMPLETION_TOKENS,
  FREE_MAX_INPUT_TOKENS,
  FREE_MONTHLY_INPUT_TOKENS,
  FREE_MONTHLY_OUTPUT_TOKENS,
  MANAGED_MODEL_ALIAS,
  MAX_COMPLETION_TOKENS,
  PAID_MAX_INPUT_TOKENS,
  PAID_MAX_REQUEST_TOKENS,
  PRO_MONTHLY_INPUT_TOKENS,
  PRO_MONTHLY_OUTPUT_TOKENS,
  PRODUCT_ID_FREE,
  PRODUCT_ID_PRO,
  STATUS,
} from "../src/constants";
import type { Env, ProxyConfig } from "../src/config";
import { readConfig } from "../src/config";
import {
  clientVisibleModel,
  handleChatCompletions,
  handleImageGenerations,
  handleModels,
  isAllowedModel,
  rewriteUpstreamBody,
} from "../src/proxy";
import { isWellFormedVirtualKey, parseProvisionRequest, presentedKey } from "../src/provision";
import { recordTierUsage } from "../src/quota";
import { newKeyRecord, putKeyRecord } from "../src/store";
import { fakeKv } from "./fake-kv";

const config: ProxyConfig = {
  productId: "gestu_pro_monthly",
  basePlanId: "gestu-pro-monthly",
  monthlyTokenLimit: 101_500_000,
  freeMonthlyOutputTokenLimit: FREE_MONTHLY_OUTPUT_TOKENS,
  businessMonthlyTokenLimit: 1_015_000_000,
  allowedPackageNames: ["com.gestu.app"],
  proUpstreamBaseUrl: "https://api.deepseek.com/v1",
  proUpstreamModelId: "deepseek-flash",
  freeUpstreamBaseUrl: "https://api.deepseek.com/v1",
  freeUpstreamModelId: "deepseek-flash",
  exposedModels: [MANAGED_MODEL_ALIAS],
  deviceLimit: 2,
  publicBaseUrl: "https://api.gestu.ca",
  proxyBaseUrl: "https://api.gestu.ca/v1",
  allowedOrigins: [],
  googleOAuthTokenUrl: "https://oauth2.googleapis.com/token",
  googlePlayApiBase: "https://androidpublisher.googleapis.com/androidpublisher/v3",
  rtdnAudience: "",
};

describe("parseProvisionRequest", () => {
  it("accepts the exact body ProProvisionRequest serialises", () => {
    const parsed = parseProvisionRequest({
      productId: "gestu_pro_monthly",
      packageName: "com.gestu.app",
      purchaseTokens: ["tok-a", "tok-b"],
      deviceId: "device-1",
      obfuscatedAccountId: "obf-1",
      appVersion: "1.4.2",
    });
    expect(parsed).toEqual({
      productId: "gestu_pro_monthly",
      packageName: "com.gestu.app",
      purchaseTokens: ["tok-a", "tok-b"],
      deviceId: "device-1",
      obfuscatedAccountId: "obf-1",
      appVersion: "1.4.2",
    });
  });

  it("applies the client's own defaults for the optional fields", () => {
    const parsed = parseProvisionRequest({
      productId: "gestu_pro_monthly",
      packageName: "com.gestu.app",
      purchaseTokens: ["tok"],
      deviceId: "device-1",
    });
    expect(parsed.obfuscatedAccountId).toBe("");
    expect(parsed.appVersion).toBe("");
  });

  it("rejects a body that is not an object or has no token array", () => {
    expect(() => parseProvisionRequest(null)).toThrow();
    expect(() => parseProvisionRequest([])).toThrow();
    expect(() => parseProvisionRequest({ purchaseTokens: "tok" })).toThrow();
    expect(() => parseProvisionRequest({})).toThrow();
  });

  it("drops non-string and blank tokens rather than failing the whole request", () => {
    const parsed = parseProvisionRequest({ purchaseTokens: ["tok-a", "", "   ", 42, null, "tok-b"] });
    expect(parsed.purchaseTokens).toEqual(["tok-a", "tok-b"]);
  });

  it("caps the token list so a hostile client cannot burn Play API quota", () => {
    const parsed = parseProvisionRequest({
      purchaseTokens: Array.from({ length: 500 }, (_, index) => `tok-${index}`),
    });
    expect(parsed.purchaseTokens).toHaveLength(12);
  });
});

describe("rewriteUpstreamBody", () => {
  it("maps the app's Pro alias onto the DeepSeek Direct model when using default readConfig", () => {
    const defaultConfig = readConfig({ GESTU_ALLOWED_PACKAGE_NAMES: "com.gestu.app" } as Env);
    const { body, upstreamModel } = rewriteUpstreamBody(
      {
        model: MANAGED_MODEL_ALIAS,
        stream: true,
        reasoning_effort: "high",
        thinking: { type: "enabled" },
      },
      defaultConfig,
      { tier: "pro" },
    );
    expect(upstreamModel).toBe("deepseek-flash");
    expect(body["model"]).toBe("deepseek-flash");
    // The provider dialect is the same for both tiers, so the reasoning surface is kept intact.
    expect(body["reasoning_effort"]).toBe("high");
    expect(body["thinking"]).toEqual({ type: "enabled" });
  });

  it("maps the app's Pro alias onto the configured Pro upstream model", () => {
    const { body, upstreamModel } = rewriteUpstreamBody({ model: MANAGED_MODEL_ALIAS, stream: true }, config, {
      tier: "pro",
    });
    expect(upstreamModel).toBe("deepseek-flash");
    expect(body["model"]).toBe("deepseek-flash");
  });

  it("maps both Free model ids onto the configured Free upstream model", () => {
    for (const requested of [FREE_MANAGED_MODEL_ID, FREE_MANAGED_MODEL_ALIAS]) {
      const { body, upstreamModel } = rewriteUpstreamBody(
        { model: requested, stream: true },
        config,
        { tier: "free" },
      );
      expect(upstreamModel, requested).toBe("deepseek-flash");
      expect(body["model"], requested).toBe("deepseek-flash");
    }
  });

  it("forces stream_options.include_usage so usage is always reported", () => {
    const { body } = rewriteUpstreamBody({ model: MANAGED_MODEL_ALIAS, stream: true }, config, { tier: "pro" });
    expect(body["stream_options"]).toEqual({ include_usage: true });
  });

  it("preserves other stream options the client set", () => {
    const { body } = rewriteUpstreamBody(
      { model: MANAGED_MODEL_ALIAS, stream: true, stream_options: { include_usage: false, extra: 1 } },
      config,
      { tier: "pro" },
    );
    expect(body["stream_options"]).toEqual({ include_usage: true, extra: 1 });
  });

  it("does not add stream_options to a non-streaming request, which DeepSeek rejects with 400", () => {
    const { body } = rewriteUpstreamBody({ model: MANAGED_MODEL_ALIAS, stream: false }, config, { tier: "pro" });
    expect(body["stream_options"]).toBeUndefined();
  });

  it("passes every other field through untouched", () => {
    const original = {
      model: MANAGED_MODEL_ALIAS,
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      tools: [{ type: "function", function: { name: "f" } }],
      stream: true,
    };
    const { body } = rewriteUpstreamBody(original, config, { tier: "pro" });
    expect(body["messages"]).toEqual(original.messages);
    expect(body["temperature"]).toBe(0.2);
    expect(body["tools"]).toEqual(original.tools);
    // The caller's object is never mutated.
    expect(original.model).toBe(MANAGED_MODEL_ALIAS);
  });

  it("leaves a missing model alone rather than inventing one", () => {
    const { body, upstreamModel } = rewriteUpstreamBody({ messages: [] }, config, { tier: "pro" });
    expect(upstreamModel).toBe("");
    expect(body["model"]).toBeUndefined();
  });

  it("ignores a non-boolean stream flag", () => {
    const { body } = rewriteUpstreamBody({ model: MANAGED_MODEL_ALIAS, stream: "true" }, config, { tier: "pro" });
    expect(body["stream_options"]).toBeUndefined();
  });

  it("clamps the outbound max_tokens to the tier ceiling (384_000 Pro, 64_000 Free)", () => {
    const pro = rewriteUpstreamBody({ model: MANAGED_MODEL_ALIAS, max_tokens: 1_000_000 }, config, {
      tier: "pro",
    });
    expect(pro.body["max_tokens"]).toBe(MAX_COMPLETION_TOKENS);

    const free = rewriteUpstreamBody({ model: FREE_MANAGED_MODEL_ID, max_tokens: 1_000_000 }, config, {
      tier: "free",
    });
    expect(free.body["max_tokens"]).toBe(FREE_MAX_COMPLETION_TOKENS);

    const freeCompletion = rewriteUpstreamBody(
      { model: FREE_MANAGED_MODEL_ID, max_completion_tokens: 1_000_000 },
      config,
      { tier: "free" },
    );
    expect(freeCompletion.body["max_completion_tokens"]).toBe(FREE_MAX_COMPLETION_TOKENS);
  });

  it("locks Free thinking to the route default whatever depth the client names", () => {
    const { body } = rewriteUpstreamBody(
      {
        model: FREE_MANAGED_MODEL_ID,
        thinking: { type: "enabled", budget_tokens: 8_000 },
        reasoning_effort: "max",
      },
      config,
      { tier: "free" },
    );
    expect(body["thinking"]).toEqual({ type: "disabled" });
    expect(body["reasoning_effort"]).toBeUndefined();
  });

  it("leaves max_tokens unset when omitted in normal mode, disables unrequested reasoning on Free, and defaults Pro to high reasoning", () => {
    const freeDefault = rewriteUpstreamBody(
      { model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] },
      config,
      { tier: "free", mode: "normal" },
    );
    expect(freeDefault.body["thinking"]).toEqual({ type: "disabled" });
    expect(freeDefault.body["reasoning_effort"]).toBeUndefined();
    expect(freeDefault.body["max_tokens"]).toBeUndefined();
    expect(freeDefault.body["max_completion_tokens"]).toBeUndefined();

    const proDefault = rewriteUpstreamBody(
      { model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] },
      config,
      { tier: "pro", mode: "normal" },
    );
    expect(proDefault.body["thinking"]).toEqual({ type: "enabled" });
    expect(proDefault.body["reasoning_effort"]).toBe("high");
    expect(proDefault.body["max_tokens"]).toBeUndefined();
    expect(proDefault.body["max_completion_tokens"]).toBeUndefined();
  });

  it("honours an explicit request to turn thinking off on either tier", () => {
    for (const tier of ["free", "pro"] as const) {
      const requested = tier === "free" ? FREE_MANAGED_MODEL_ID : MANAGED_MODEL_ALIAS;
      const { body } = rewriteUpstreamBody(
        { model: requested, thinking: { type: "disabled" }, reasoning_effort: "high" },
        config,
        { tier, mode: "normal" },
      );
      expect(body["thinking"], tier).toEqual({ type: "disabled" });
      expect(body["reasoning_effort"], tier).toBeUndefined();
    }
  });

  it("serves a Pro max request at high and keeps the thinking config in normal mode", () => {
    const { body } = rewriteUpstreamBody(
      {
        model: MANAGED_MODEL_ALIAS,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 24_000,
        reasoning_effort: "max",
        thinking: { type: "enabled", budget_tokens: 16_000 },
      },
      config,
      { tier: "pro", mode: "normal" },
    );
    expect(body["reasoning_effort"]).toBe("high");
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 16_000 });
    expect(body["max_tokens"]).toBe(24_000);
  });

  it("lowers reasoning_effort to low in reduced mode while keeping thinking enabled", () => {
    const { body } = rewriteUpstreamBody(
      {
        model: MANAGED_MODEL_ALIAS,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16_384,
        reasoning_effort: "high",
        thinking: { type: "enabled" },
      },
      config,
      { tier: "pro", mode: "reduced" },
    );
    expect(body["thinking"]).toEqual({ type: "enabled" });
    expect(body["reasoning_effort"]).toBe("low");
    expect(body["max_tokens"]).toBe(4_096);
  });

  it("omits DeepSeek thinking object on Azure AI Foundry and uses reasoning_effort=none in reduced mode", () => {
    const azureConfig: ProxyConfig = {
      ...config,
      proUpstreamBaseUrl: "https://robert-6620-resource.services.ai.azure.com/openai/v1",
      proUpstreamModelId: "DeepSeek-V4.1-Flash-1017",
      freeUpstreamBaseUrl: "https://robert-6620-resource.services.ai.azure.com/openai/v1",
      freeUpstreamModelId: "DeepSeek-V4.1-Flash-1017",
    };

    const freeNormal = rewriteUpstreamBody(
      {
        model: FREE_MANAGED_MODEL_ID,
        messages: [{ role: "user", content: "hi" }],
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      },
      azureConfig,
      { tier: "free", mode: "normal" },
    );
    expect(freeNormal.body["model"]).toBe("DeepSeek-V4.1-Flash-1017");
    expect(freeNormal.body["thinking"]).toBeUndefined();
    expect(freeNormal.body["reasoning_effort"]).toBeUndefined();

    const proReduced = rewriteUpstreamBody(
      {
        model: MANAGED_MODEL_ALIAS,
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
        thinking: { type: "enabled" },
      },
      azureConfig,
      { tier: "pro", mode: "reduced" },
    );
    expect(proReduced.body["thinking"]).toBeUndefined();
    expect(proReduced.body["reasoning_effort"]).toBe("none");
    expect(proReduced.body["max_tokens"]).toBe(4_096);
  });
});

describe("isAllowedModel / clientVisibleModel", () => {
  it("keeps each tier's ids separate", () => {
    expect(isAllowedModel(MANAGED_MODEL_ALIAS, config, "pro")).toBe(true);
    expect(isAllowedModel("deepseek-flash", config, "pro")).toBe(false);
    expect(isAllowedModel("deepseek-flash", { ...config, exposedModels: ["deepseek-flash"] }, "pro")).toBe(true);

    expect(isAllowedModel(FREE_MANAGED_MODEL_ID, config, "free")).toBe(true);
    expect(isAllowedModel(FREE_MANAGED_MODEL_ALIAS, config, "free")).toBe(true);
    // A Free key cannot ask for the Pro alias, and a Pro key cannot ask for the Free model.
    expect(isAllowedModel(MANAGED_MODEL_ALIAS, config, "free")).toBe(false);
    expect(isAllowedModel(FREE_MANAGED_MODEL_ID, config, "pro")).toBe(false);
  });

  it("refuses an arbitrary model id", () => {
    expect(isAllowedModel("gpt-4o", config, "pro")).toBe(false);
    expect(isAllowedModel("gpt-4o", config, "free")).toBe(false);
    expect(isAllowedModel("", config, "pro")).toBe(false);
    expect(isAllowedModel("", config, "free")).toBe(false);
  });

  it("echoes the client's own id back, never the upstream's", () => {
    expect(clientVisibleModel(MANAGED_MODEL_ALIAS, "pro")).toBe(MANAGED_MODEL_ALIAS);
    expect(clientVisibleModel(FREE_MANAGED_MODEL_ID, "free")).toBe(FREE_MANAGED_MODEL_ID);
    expect(clientVisibleModel(FREE_MANAGED_MODEL_ALIAS, "free")).toBe(FREE_MANAGED_MODEL_ALIAS);
    expect(clientVisibleModel("", "free")).toBe(FREE_MANAGED_MODEL_ID);
    expect(clientVisibleModel("", "pro")).toBe(MANAGED_MODEL_ALIAS);
  });
});

describe("handleModels", () => {
  it("advertises both managed tiers without naming a provider", async () => {
    const response = handleModels({} as Env, config);
    const body = (await response.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = body.data.map((entry) => entry.id);
    expect(ids).toContain(MANAGED_MODEL_ALIAS);
    expect(ids).toContain(FREE_MANAGED_MODEL_ID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of body.data) expect(entry.owned_by).toBe("gestu");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("deepseek");
  });
});

describe("presentedKey", () => {
  const request = (headers: Record<string, string>): Request =>
    new Request("https://api.gestu.ca/v1/chat/completions", { method: "POST", headers });

  it("prefers the app's own subscription header", () => {
    expect(
      presentedKey(request({ "X-Gestu-Subscription": "msk_from-header", authorization: "Bearer msk_from-bearer" })),
    ).toBe("msk_from-header");
  });

  it("accepts a bearer token, which is how the app's managed route authenticates", () => {
    expect(presentedKey(request({ authorization: "Bearer msk_bearer" }))).toBe("msk_bearer");
    expect(presentedKey(request({ authorization: "bearer msk_lower" }))).toBe("msk_lower");
  });

  it("returns empty when nothing was presented", () => {
    expect(presentedKey(request({}))).toBe("");
    expect(presentedKey(request({ authorization: "Basic abc" }))).toBe("");
    expect(presentedKey(request({ "X-Gestu-Subscription": "   " }))).toBe("");
  });
});

describe("isWellFormedVirtualKey", () => {
  it("accepts a minted key and refuses everything else", () => {
    expect(isWellFormedVirtualKey(`gsk_${"a".repeat(43)}`)).toBe(true);
    expect(isWellFormedVirtualKey(`msk_${"a".repeat(43)}`)).toBe(true);
    expect(isWellFormedVirtualKey("msk_short")).toBe(false);
    expect(isWellFormedVirtualKey(`sk-${"a".repeat(43)}`)).toBe(false);
  });
});

describe("handleChatCompletions server-enforced moat (Free / Pro)", () => {
  const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
  const FUTURE = NOW + 30 * 86_400_000;

  interface Seeded {
    kv: ReturnType<typeof fakeKv>;
    env: Env;
    vKey: string;
    meterId: string;
  }

  async function seedKey(productId: string): Promise<Seeded> {
    const kv = fakeKv();
    const vKey = mintVirtualKey();
    const keyId = await sha256Hex(vKey);
    const meterId = productId === PRODUCT_ID_FREE ? `free-device:${keyId}` : keyId;
    const record = newKeyRecord({
      keyId,
      packageName: "com.gestu.app",
      productId,
      obfuscatedAccountId: "",
      // Free keys never expire; Pro keys carry the paid period.
      expiresAt: productId === PRODUCT_ID_FREE ? 0 : FUTURE,
      status: STATUS.ACTIVE,
      playState: "SUBSCRIPTION_STATE_ACTIVE",
      latestOrderId: "GPA.1",
      deviceId: "dev-1",
      deviceLimit: 2,
      now: NOW,
    });
    await putKeyRecord(kv, { ...record, meterId });
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "com.gestu.app",
      UPSTREAM_API_KEY: "test-pro-upstream",
      UPSTREAM_BASE_URL: "https://api.deepseek.com",
      UPSTREAM_MODEL_ID: "deepseek-flash",
      GEMINI_FREE_API_KEY: "test-free-upstream",
    };
    return { kv, env, vKey, meterId };
  }

  function makeChatReq(vKey: string, bodyObj: unknown, ip = "203.0.113.7"): Request {
    return new Request("https://api.gestu.ca/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${vKey}`,
        "content-type": "application/json",
        "cf-connecting-ip": ip,
      },
      body: JSON.stringify(bodyObj),
    });
  }

  function mockJsonUpstream(capture: (body: Record<string, unknown> | null, url: string) => void): () => void {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
      capture(body, url);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: String(body?.["model"] ?? ""),
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  it("Free tier: routes to the DeepSeek Direct upstream, clamps max_tokens before the budget check, locks thinking to the default, and enforces the output cap", async () => {
    const { kv, env, vKey, meterId } = await seedKey(PRODUCT_ID_FREE);
    const requestConfig = readConfig(env);

    // 1. A hostile huge max_tokens is clamped BEFORE the pre-flight estimate, so the request
    //    succeeds (it used to be rejected by the per-request budget check) and the outbound body
    //    carries the Free ceiling.
    let sentBody: Record<string, unknown> | null = null;
    let sentUrl = "";
    const restore = mockJsonUpstream((body, url) => {
      sentBody = body;
      sentUrl = url;
    });
    try {
      const res = await handleChatCompletions(
        makeChatReq(vKey, {
          model: FREE_MANAGED_MODEL_ID,
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 500_000,
          reasoning_effort: "high",
          thinking: { type: "enabled", budget_tokens: 4_000 },
        }),
        env,
        requestConfig,
        NOW,
      );
      expect(res.status).toBe(200);
      expect(sentUrl).toContain("api.deepseek.com");
      expect(sentBody!["model"]).toBe("deepseek-flash");
      expect(sentBody!["max_tokens"]).toBe(FREE_MAX_COMPLETION_TOKENS);
      // Free thinking is locked to the route default, whatever the client asked for.
      expect(sentBody!["thinking"]).toEqual({ type: "disabled" });
      expect(sentBody!["reasoning_effort"]).toBeUndefined();
      // The response body is rewritten back to the public model id, not the upstream's raw id.
      const payload = (await res.json()) as { model: string };
      expect(payload.model).toBe(FREE_MANAGED_MODEL_ID);
      // The quota mirror describes the output allowance the plan advertises.
      expect(res.headers.get("X-Gestu-Quota-Limit")).toBe(String(FREE_MONTHLY_OUTPUT_TOKENS));
      expect(res.headers.get("X-Gestu-Quota-Unit")).toBe("tokens");
    } finally {
      restore();
    }

    // 2. Request body larger than the Free per-request input budget is refused (413).
    const oversizedInputText = "x".repeat((FREE_MAX_INPUT_TOKENS + 100) * 4);
    const bigInputRes = await handleChatCompletions(
      makeChatReq(vKey, { model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: oversizedInputText }] }),
      env,
      requestConfig,
      NOW,
    );
    expect(bigInputRes.status).toBe(413);

    // 3. Enforces the 200,000 monthly output cap (429 + quota headers).
    await recordTierUsage(kv, meterId, 1_000, FREE_MONTHLY_OUTPUT_TOKENS, NOW);
    const outCapRes = await handleChatCompletions(
      makeChatReq(vKey, { model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hello" }] }),
      env,
      requestConfig,
      NOW,
    );
    expect(outCapRes.status).toBe(429);
    expect(outCapRes.headers.get("X-Gestu-Quota-Limit")).toBe(String(FREE_MONTHLY_OUTPUT_TOKENS));
    const outCapBody = (await outCapRes.json()) as { error: { code: string; message: string } };
    expect(outCapBody.error.code).toBe("quota_exceeded");
    expect(outCapBody.error.message).toContain("Gestu Free");
    expect(outCapBody.error.message.toLowerCase()).not.toContain("deepseek");
    expect(outCapBody.error.message.toLowerCase()).not.toContain("gemini");

    // 4. Enforces the Free input cost-control cap (429) on a fresh Free key.
    const freeInKey = await seedKey(PRODUCT_ID_FREE);
    await recordTierUsage(freeInKey.kv, freeInKey.meterId, FREE_MONTHLY_INPUT_TOKENS, 100, NOW);
    const inCapRes = await handleChatCompletions(
      makeChatReq(freeInKey.vKey, { model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
      freeInKey.env,
      readConfig(freeInKey.env),
      NOW,
    );
    expect(inCapRes.status).toBe(429);
  });

  it("Free tier: refuses the Pro alias, applies per-IP+device rate limiting, and requires the Free upstream key", async () => {
    const { env, vKey } = await seedKey(PRODUCT_ID_FREE);
    const requestConfig = readConfig(env);

    // Cross-tier model request is refused by the router, not silently downgraded.
    const wrongModel = await handleChatCompletions(
      makeChatReq(vKey, { model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }, "198.51.100.11"),
      env,
      requestConfig,
      NOW,
    );
    expect(wrongModel.status).toBe(404);

    // The Free route fails closed when its own upstream secret is missing.
    const noKeyEnv: Env = { ...env, GEMINI_FREE_API_KEY: undefined };
    const noKey = await handleChatCompletions(
      makeChatReq(
        vKey,
        { model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] },
        "198.51.100.12",
      ),
      noKeyEnv,
      readConfig(noKeyEnv),
      NOW,
    );
    expect(noKey.status).toBe(503);
    const noKeyBody = (await noKey.json()) as { error: { code: string; message: string } };
    expect(noKeyBody.error.code).toBe("server_misconfigured");
    expect(JSON.stringify(noKeyBody).toLowerCase()).not.toContain("gemini");
    expect(JSON.stringify(noKeyBody).toLowerCase()).not.toContain("vendor");

    // FREE_CHAT_RATE_LIMIT requests in the same minute are allowed; the next is the anti-abuse 429 with Retry-After.
    const rateLimitIp = "198.51.100.13";
    const restore = mockJsonUpstream(() => undefined);
    try {
      for (let index = 0; index < FREE_CHAT_RATE_LIMIT; index += 1) {
        const allowed = await handleChatCompletions(
          makeChatReq(
            vKey,
            { model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] },
            rateLimitIp,
          ),
          env,
          requestConfig,
          NOW,
        );
        expect(allowed.status, `request ${index}`).toBe(200);
      }
      const limited = await handleChatCompletions(
        makeChatReq(
          vKey,
          { model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] },
          rateLimitIp,
        ),
        env,
        requestConfig,
        NOW,
      );
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      const limitedBody = (await limited.json()) as { error: { code: string } };
      expect(limitedBody.error.code).toBe("rate_limited");
      expect(limited.headers.get("X-Gestu-Quota-Limit")).toBe(String(FREE_MONTHLY_OUTPUT_TOKENS));
    } finally {
      restore();
    }
  });

  it("Pro tier: routes to the Pro upstream, serves max thinking at high, and enforces 1.5M output / 100M input caps", async () => {
    const { kv, env, vKey, meterId } = await seedKey(PRODUCT_ID_PRO);
    const requestConfig = readConfig(env);

    let sentBody: Record<string, unknown> | null = null;
    let sentUrl = "";
    const restore = mockJsonUpstream((body, url) => {
      sentBody = body;
      sentUrl = url;
    });
    try {
      const res = await handleChatCompletions(
        makeChatReq(vKey, {
          model: MANAGED_MODEL_ALIAS,
          messages: [{ role: "user", content: "deep analysis" }],
          reasoning_effort: "max",
          thinking: { type: "enabled", budget_tokens: 16_000 },
          max_tokens: MAX_COMPLETION_TOKENS,
        }),
        env,
        requestConfig,
        NOW,
      );
      expect(res.status).toBe(200);
      expect(sentUrl).toContain("api.deepseek.com");
      expect(sentBody!["model"]).toBe("deepseek-flash");
      expect(sentBody!["reasoning_effort"]).toBe("high");
      expect(sentBody!["thinking"]).toEqual({ type: "enabled", budget_tokens: 16_000 });
      expect(sentBody!["max_tokens"]).toBe(MAX_COMPLETION_TOKENS);
      const payload = (await res.json()) as { model: string };
      expect(payload.model).toBe(MANAGED_MODEL_ALIAS);
      expect(res.headers.get("X-Gestu-Quota-Limit")).toBe(String(PRO_MONTHLY_OUTPUT_TOKENS));
    } finally {
      restore();
    }

    // Rejects input beyond PAID_MAX_INPUT_TOKENS (413).
    const oversizedPro = "x".repeat((PAID_MAX_INPUT_TOKENS + 100) * 4);
    const overInput = await handleChatCompletions(
      makeChatReq(vKey, { model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: oversizedPro }] }),
      env,
      requestConfig,
      NOW,
    );
    expect(overInput.status).toBe(413);

    // Enforces the 1,500,000 monthly output cap.
    await recordTierUsage(kv, meterId, 1_000, PRO_MONTHLY_OUTPUT_TOKENS, NOW);
    const outCapRes = await handleChatCompletions(
      makeChatReq(vKey, { model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
      env,
      requestConfig,
      NOW,
    );
    expect(outCapRes.status).toBe(429);

    // Enforces the 100,000,000 monthly input cap.
    const proInKey = await seedKey(PRODUCT_ID_PRO);
    await recordTierUsage(proInKey.kv, proInKey.meterId, PRO_MONTHLY_INPUT_TOKENS, 100, NOW);
    const inCapRes = await handleChatCompletions(
      makeChatReq(proInKey.vKey, { model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
      proInKey.env,
      readConfig(proInKey.env),
      NOW,
    );
    expect(inCapRes.status).toBe(429);
  });

  it("Pro tier: a huge max_tokens is clamped, not rejected by the pre-flight budget", async () => {
    const { env, vKey } = await seedKey(PRODUCT_ID_PRO);
    let sentBody: Record<string, unknown> | null = null;
    const restore = mockJsonUpstream((body) => {
      sentBody = body;
    });
    try {
      const res = await handleChatCompletions(
        makeChatReq(vKey, {
          model: MANAGED_MODEL_ALIAS,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: PAID_MAX_REQUEST_TOKENS * 4,
        }),
        env,
        readConfig(env),
        NOW,
      );
      expect(res.status).toBe(200);
      expect(sentBody!["max_tokens"]).toBe(MAX_COMPLETION_TOKENS);
    } finally {
      restore();
    }
  });

  it("rejects a cancelled-but-paid subscription only once the paid period has ended", async () => {
    const { kv, env, vKey } = await seedKey(PRODUCT_ID_PRO);
    const requestConfig = readConfig(env);
    const record = JSON.parse((await kv.get(`key:${await sha256Hex(vKey)}`))!);
    await putKeyRecord(kv, { ...record, status: STATUS.CANCELED, expiresAt: NOW + 86_400_000 });

    const restore = mockJsonUpstream(() => undefined);
    try {
      const res = await handleChatCompletions(
        makeChatReq(vKey, { model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
        env,
        requestConfig,
        NOW,
      );
      expect(res.status).toBe(200);
    } finally {
      restore();
    }

    // Past the paid period, the same record is refused with the subscription-inactive 403.
    const expired = await handleChatCompletions(
      makeChatReq(vKey, { model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
      env,
      requestConfig,
      NOW + 2 * 86_400_000,
    );
    expect(expired.status).toBe(403);
  });

  it("never leaves an unhandled rejection when quota persistence fails after a stream", async () => {
    const { env, vKey } = await seedKey(PRODUCT_ID_PRO);
    // A KV that fails only on the metering writes, after the client response has already started.
    const seeded = (env.PRO_KV as ReturnType<typeof fakeKv>).dump();
    const baseKv = fakeKv();
    for (const [key, value] of seeded) baseKv.dump().set(key, value);
    const failingKv = {
      ...baseKv,
      get: baseKv.get.bind(baseKv),
      delete: baseKv.delete.bind(baseKv),
      list: baseKv.list.bind(baseKv),
      put: async (key: string, value: string, options?: unknown) => {
        if (key.startsWith("quota:")) throw new Error("KV write failed");
        return baseKv.put(key, value, options as never);
      },
    } as unknown as Env["PRO_KV"];
    const streamEnv: Env = { ...env, PRO_KV: failingKv };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"id":"1","model":"deepseek-flash","choices":[{"delta":{"content":"Hi"}}]}\n\n' +
                  'data: {"id":"1","model":"deepseek-flash","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
                  "data: [DONE]\n\n",
              ),
            );
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const waitUntilPromises: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
      passThroughOnException() {},
    } as unknown as ExecutionContext;

    try {
      const res = await handleChatCompletions(
        makeChatReq(vKey, {
          model: MANAGED_MODEL_ALIAS,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
        streamEnv,
        readConfig(streamEnv),
        NOW,
        ctx,
      );
      expect(res.status).toBe(200);
      await res.text();
      expect(waitUntilPromises).toHaveLength(1);
      // The detached meter promise must settle (and swallow/log the failure), never reject.
      await expect(Promise.all(waitUntilPromises)).resolves.toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POST /v1/images/generations: blocks Free tier (403), fails closed without IMAGE_GEN_API_KEY (503), and forwards Pro requests with bearer secret", async () => {
    const freeSeed = await seedKey(PRODUCT_ID_FREE);
    const freeRes = await handleImageGenerations(
      new Request("https://api.gestu.ca/v1/images/generations", {
        method: "POST",
        headers: { authorization: `Bearer ${freeSeed.vKey}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Mars horizon" }),
      }),
      { ...freeSeed.env, IMAGE_GEN_API_KEY: "img-secret-123" },
      readConfig(freeSeed.env),
      NOW,
    );
    expect(freeRes.status).toBe(403);

    const proSeed = await seedKey(PRODUCT_ID_PRO);
    const noSecretRes = await handleImageGenerations(
      new Request("https://api.gestu.ca/v1/images/generations", {
        method: "POST",
        headers: { authorization: `Bearer ${proSeed.vKey}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Mars horizon" }),
      }),
      proSeed.env,
      readConfig(proSeed.env),
      NOW,
    );
    expect(noSecretRes.status).toBe(503);

    let capturedAuth = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedAuth = headers.get("authorization") ?? "";
      return new Response(JSON.stringify({ created: 1, data: [{ b64_json: "aGVsbG8=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const proEnv: Env = { ...proSeed.env, IMAGE_GEN_API_KEY: "img-secret-123" };
      const proRes = await handleImageGenerations(
        new Request("https://api.gestu.ca/v1/images/generations", {
          method: "POST",
          headers: { authorization: `Bearer ${proSeed.vKey}`, "content-type": "application/json" },
          body: JSON.stringify({ prompt: "Mars horizon", response_format: "b64_json" }),
        }),
        proEnv,
        readConfig(proEnv),
        NOW,
      );
      expect(proRes.status).toBe(200);
      expect(capturedAuth).toBe("Bearer img-secret-123");
      expect(proRes.headers.get("X-Gestu-Image-Quota-Used")).toBe("1");
      expect(proRes.headers.get("X-Gestu-Quota-Input-Used")).toBe("0");
      expect(proRes.headers.get("X-Gestu-Quota-Output-Used")).toBe("0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
