import { describe, expect, it, vi } from "vitest";
import worker, { InternalApi, LicenceMeter } from "../src/index";
import { callLicenceMeter } from "../src/licence-meter";
import { mintVirtualKey, sha256Hex } from "../src/base64";
import type { Env } from "../src/config";
import { readConfig } from "../src/config";
import { FREE_MANAGED_MODEL_ID, MANAGED_MODEL_ALIAS, STATUS } from "../src/constants";
import {
  calculateCostMicroUsd,
  DEFAULT_PRICE_TABLE,
  estimateFallbackUsage,
  extractDetailedUsage,
  isPeakHourUtc,
  microUsdToPpm,
  parsePriceTable,
} from "../src/cost";
import { handleChatCompletions } from "../src/proxy";
import { fakeKv } from "./fake-kv";

function createFakeLicenceMeterNamespace(env: Env): DurableObjectNamespace {
  const instances = new Map<string, LicenceMeter>();
  return {
    idFromName(name: string): DurableObjectId {
      return { toString: () => name, equals: (other: DurableObjectId) => other.toString() === name } as DurableObjectId;
    },
    get(id: DurableObjectId): DurableObjectStub {
      const key = id.toString();
      let instance = instances.get(key);
      if (!instance) {
        instance = new LicenceMeter({} as DurableObjectState, env);
        instances.set(key, instance);
      }
      return instance as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

describe("cost.ts — peak/off-peak pricing & ppm math", () => {
  it("identifies weekday peak windows in UTC (01:00–04:00 and 06:00–10:00 UTC)", () => {
    // Wednesday 2026-10-14
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 0, 30))).toBe(false);
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 1, 0))).toBe(true);
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 3, 59))).toBe(true);
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 4, 0))).toBe(false);
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 5, 30))).toBe(false);
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 6, 0))).toBe(true);
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 9, 59))).toBe(true);
    expect(isPeakHourUtc(Date.UTC(2026, 9, 14, 10, 0))).toBe(false);
    // Saturday 2026-10-17 02:00 UTC -> weekend is off-peak
    expect(isPeakHourUtc(Date.UTC(2026, 9, 17, 2, 0))).toBe(false);
  });

  it("extracts prompt_cache_hit_tokens and prompt_cache_miss_tokens with OpenAI cached_tokens fallback", () => {
    const deepseekShape = extractDetailedUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    });
    expect(deepseekShape).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      cacheHitTokens: 800,
      cacheMissTokens: 200,
    });

    const openaiShape = extractDetailedUsage({
      prompt_tokens: 1000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 600 },
    });
    expect(openaiShape).toEqual({
      promptTokens: 1000,
      completionTokens: 300,
      cacheHitTokens: 600,
      cacheMissTokens: 400,
    });
  });

  it("calculates micro-USD cost for peak vs off-peak and converts to ppm", () => {
    const usage = {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cacheHitTokens: 500_000,
      cacheMissTokens: 500_000,
    };
    // Peak: 0.5M * $0.006/M + 0.5M * $0.300/M + 1M * $1.200/M = 3,000 + 150,000 + 1,200,000 = 1,353,000 µUSD
    const peakTime = Date.UTC(2026, 9, 14, 2, 0);
    expect(calculateCostMicroUsd({ usage, priceTable: DEFAULT_PRICE_TABLE, now: peakTime })).toBe(1_353_000);

    // Off-peak: half of peak = 676,500 µUSD
    const offPeakTime = Date.UTC(2026, 9, 14, 15, 0);
    expect(calculateCostMicroUsd({ usage, priceTable: DEFAULT_PRICE_TABLE, now: offPeakTime })).toBe(676_500);

    // 2,000,000 µUSD against 4,000,000 µUSD soft cap = 500,000 ppm (50%)
    expect(microUsdToPpm(2_000_000, 4_000_000)).toBe(500_000);
    // 4,000,000 µUSD = 1,000,000 ppm (100%)
    expect(microUsdToPpm(4_000_000, 4_000_000)).toBe(1_000_000);
    // 6,000,000 µUSD = 1,500,000 ppm (150% hard cap)
    expect(microUsdToPpm(6_000_000, 4_000_000)).toBe(1_500_000);
  });

  it("parses custom GESTU_PRICE_TABLE overrides and estimates fallback usage on truncated streams", () => {
    const custom = parsePriceTable(
      JSON.stringify({
        offPeak: { cacheHit: 0.01, cacheMiss: 0.2, output: 0.8 },
        peak: { cacheHit: 0.02, cacheMiss: 0.4, output: 1.6 },
      }),
    );
    expect(custom["default"]?.peak.output).toBe(1.6);
    expect(custom["default"]?.offPeak.output).toBe(0.8);

    const est = estimateFallbackUsage(400, 800);
    expect(est.promptTokens).toBe(100);
    expect(est.completionTokens).toBe(200);
    expect(est.cacheMissTokens).toBe(100);
  });
});

describe("LicenceMeter DO & InternalApi RPC", () => {
  const NOW = Date.UTC(2026, 9, 15, 14, 0, 0);
  const FUTURE = NOW + 30 * 86_400_000;

  it("enforces 2-device seat limit, supports 14-day idle eviction, and revokes released keys", async () => {
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "ca.gestu.app",
      UPSTREAM_API_KEY: "test-upstream-key",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);

    const rpc = new InternalApi({} as ExecutionContext, env);

    const key1 = await sha256Hex(mintVirtualKey());
    const key2 = await sha256Hex(mintVirtualKey());
    const key3 = await sha256Hex(mintVirtualKey());

    const r1 = await rpc.upsertDevice({
      licenceId: "lic_1",
      deviceId: "dev_1",
      keyId: key1,
      status: "active",
      plan: "pro_yearly",
      periodEnd: FUTURE,
      notAfter: FUTURE + 7 * 86_400_000,
      monthlyCapMicroUsd: 4_000_000,
      now: NOW,
    });
    expect(r1.ok).toBe(true);

    const r2 = await rpc.upsertDevice({
      licenceId: "lic_1",
      deviceId: "dev_2",
      keyId: key2,
      status: "active",
      plan: "pro_yearly",
      periodEnd: FUTURE,
      notAfter: FUTURE + 7 * 86_400_000,
      monthlyCapMicroUsd: 4_000_000,
      now: NOW + 1000,
    });
    expect(r2.ok).toBe(true);

    // 3rd device while both seats are active within 14d -> refused with device_limit
    const r3 = await rpc.upsertDevice({
      licenceId: "lic_1",
      deviceId: "dev_3",
      keyId: key3,
      status: "active",
      plan: "pro_yearly",
      periodEnd: FUTURE,
      notAfter: FUTURE + 7 * 86_400_000,
      monthlyCapMicroUsd: 4_000_000,
      now: NOW + 2000,
    });
    expect(r3).toEqual({ ok: false, reason: "device_limit", limit: 2 });

    // After 15 days of inactivity on dev_1, dev_3 can evict dev_1
    const fifteenDaysLater = NOW + 15 * 86_400_000;
    // Refresh dev_2 so dev_1 is the only idle device
    await rpc.upsertDevice({
      licenceId: "lic_1",
      deviceId: "dev_2",
      keyId: key2,
      status: "active",
      plan: "pro_yearly",
      periodEnd: FUTURE,
      notAfter: FUTURE + 7 * 86_400_000,
      monthlyCapMicroUsd: 4_000_000,
      now: fifteenDaysLater - 1000,
    });

    const r3AfterIdle = await rpc.upsertDevice({
      licenceId: "lic_1",
      deviceId: "dev_3",
      keyId: key3,
      status: "active",
      plan: "pro_yearly",
      periodEnd: FUTURE,
      notAfter: FUTURE + 7 * 86_400_000,
      monthlyCapMicroUsd: 4_000_000,
      now: fifteenDaysLater,
    });
    expect(r3AfterIdle.ok).toBe(true);
    if (r3AfterIdle.ok) {
      expect(r3AfterIdle.evictedKeyId).toBe(key1);
    }

    // Release dev_2 explicitly -> key2 is tombstoned in KV
    const rel = await rpc.releaseDevice({ licenceId: "lic_1", deviceId: "dev_2", now: fifteenDaysLater });
    expect(rel.releasedKeyId).toBe(key2);
    const key2Record = JSON.parse((await kv.get(`key:${key2}`))!);
    expect(key2Record.status).toBe(STATUS.REVOKED);
  });

  it("enforces soft cap (reduced mode: thinking disabled, max_tokens <= 4096) and 150% hard cap (429)", async () => {
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "ca.gestu.app",
      UPSTREAM_BASE_URL: "https://northamerica-northeast1-aiplatform.googleapis.com/v1/openapi",
      UPSTREAM_MODEL_ID: "deepseek-ai/deepseek-v4.1-flash-maas",
      UPSTREAM_API_KEY: "gcp-vertex-key",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);

    const rpc = new InternalApi({} as ExecutionContext, env);
    const vKey = mintVirtualKey();
    const keyId = await sha256Hex(vKey);

    await rpc.upsertDevice({
      licenceId: "lic_cap",
      deviceId: "dev_1",
      keyId,
      status: "active",
      plan: "pro_yearly",
      periodEnd: FUTURE,
      notAfter: FUTURE,
      monthlyCapMicroUsd: 4_000_000,
      now: NOW,
    });

    // Record $4.20 of spend (105% of soft cap -> reduced mode)
    await callLicenceMeterDirect(env.LICENCE_METER, "lic_cap", 4_200_000, 10_000_000, NOW);

    let capturedUpstreamBody: Record<string, unknown> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedUpstreamBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "deepseek-ai/deepseek-v4.1-flash-maas",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from elsewhere" } }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            prompt_cache_hit_tokens: 500,
            prompt_cache_miss_tokens: 500,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const req = new Request("https://pro.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${vKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MANAGED_MODEL_ALIAS,
          messages: [{ role: "user", content: "test" }],
          max_tokens: 16384,
          thinking: { type: "enabled" },
        }),
      });

      const res = await handleChatCompletions(req, env, readConfig(env), NOW);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Gestu-Quota-Unit")).toBe("ppm");
      expect(res.headers.get("X-Gestu-Quota-Mode")).toBe("reduced");
      expect(res.headers.get("X-Gestu-Quota-Limit")).toBe("1000000");
      expect(Number(res.headers.get("X-Gestu-Quota-Used"))).toBe(1_050_000);

      // Verify upstream body lowered reasoning_effort to "low" (keeping thinking enabled) and clamped max_tokens to 4096
      expect(capturedUpstreamBody).not.toBeNull();
      expect(capturedUpstreamBody!["thinking"]).toEqual({ type: "enabled" });
      expect(capturedUpstreamBody!["reasoning_effort"]).toBe("low");
      expect(capturedUpstreamBody!["max_tokens"]).toBe(4096);

      // Now push spend to $6.00 (1,500,000 ppm = 150% hard cap) -> must return 429
      await callLicenceMeterDirect(env.LICENCE_METER, "lic_cap", 1_800_000, 5_000_000, NOW);
      const resHardCap = await handleChatCompletions(
        new Request("https://pro.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${vKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "test" }] }),
        }),
        env,
        readConfig(env),
        NOW,
      );
      expect(resHardCap.status).toBe(429);
      expect(resHardCap.headers.get("X-Gestu-Quota-Unit")).toBe("ppm");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("masks upstream HTTP 402 as 503 upstream_unavailable and uses ctx.waitUntil on streams", async () => {
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "ca.gestu.app",
      UPSTREAM_BASE_URL: "https://northamerica-northeast1-aiplatform.googleapis.com/v1/openapi",
      UPSTREAM_MODEL_ID: "deepseek-ai/deepseek-v4.1-flash-maas",
      UPSTREAM_API_KEY: "gcp-vertex-key",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);

    const rpc = new InternalApi({} as ExecutionContext, env);
    const vKey = mintVirtualKey();
    const keyId = await sha256Hex(vKey);

    await rpc.upsertDevice({
      licenceId: "lic_stream",
      deviceId: "dev_1",
      keyId,
      status: "active",
      plan: "pro_yearly",
      periodEnd: FUTURE,
      notAfter: FUTURE,
      monthlyCapMicroUsd: 4_000_000,
      now: NOW,
    });

    const originalFetch = globalThis.fetch;
    try {
      // 1. Upstream returns 402 -> proxy masks as 503
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
      );

      const res402 = await handleChatCompletions(
        new Request("https://pro.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${vKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
        readConfig(env),
        NOW,
      );
      expect(res402.status).toBe(503);
      const errBody = (await res402.json()) as { error: { code: string } };
      expect(errBody.error.code).toBe("upstream_unavailable");

      // 2. Streaming response registers meter promise with ctx.waitUntil
      const sseFrames =
        'data: {"id":"1","model":"deepseek-ai/deepseek-v4.1-flash-maas","choices":[{"delta":{"content":"Bonjour"}}]}\n\n' +
        'data: {"id":"1","model":"deepseek-ai/deepseek-v4.1-flash-maas","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10000,"completion_tokens":5000,"prompt_cache_hit_tokens":5000,"prompt_cache_miss_tokens":5000}}\n\n' +
        "data: [DONE]\n\n";
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(sseFrames));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );

      const waitUntilPromises: Promise<unknown>[] = [];
      const fakeCtx = {
        waitUntil(p: Promise<unknown>) {
          waitUntilPromises.push(p);
        },
        passThroughOnException() {},
      } as unknown as ExecutionContext;

      const streamRes = await handleChatCompletions(
        new Request("https://pro.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${vKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: MANAGED_MODEL_ALIAS,
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
        env,
        readConfig(env),
        NOW,
        fakeCtx,
      );
      expect(streamRes.status).toBe(200);
      const clientText = await streamRes.text();
      expect(clientText).toContain('"model":"gestu-pro-flash"');
      expect(waitUntilPromises).toHaveLength(1);
      await Promise.all(waitUntilPromises);

      const usageAfter = await rpc.getUsage({ licenceId: "lic_stream", now: NOW });
      expect(usageAfter.tokens).toBe(15_000);
      expect(usageAfter.usedMicroUsd).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces the LOCKED per-tier output and input token caps in LicenceMeter DO for Free and Pro", async () => {
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "ca.gestu.app",
      UPSTREAM_API_KEY: "test-upstream-key",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);
    const rpc = new InternalApi({} as ExecutionContext, env);

    const cases = [
      { licenceId: "lic_free", plan: "gestu_free", outCap: 200_000, inCap: 15_000_000 },
      { licenceId: "lic_pro", plan: "gestu_pro_monthly", outCap: 1_500_000, inCap: 100_000_000 },
    ];

    for (const c of cases) {
      const vKey = mintVirtualKey();
      const keyId = await sha256Hex(vKey);
      await rpc.upsertDevice({
        licenceId: c.licenceId,
        deviceId: "dev_1",
        keyId,
        status: "active",
        plan: c.plan,
        periodEnd: FUTURE,
        notAfter: FUTURE,
        monthlyCapMicroUsd: 40_000_000,
        now: NOW,
      });

      const stub = env.LICENCE_METER!.get(env.LICENCE_METER!.idFromName(c.licenceId)) as unknown as LicenceMeter;
      await stub.recordSpend({
        costMicroUsd: 100,
        tokens: c.outCap,
        inputTokens: 1_000,
        outputTokens: c.outCap,
        now: NOW,
      });

      const resOut = await handleChatCompletions(
        new Request("https://pro.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${vKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
        readConfig(env),
        NOW,
      );
      expect(resOut.status, `${c.plan} output cap`).toBe(429);

      // Input cap check on separate licence
      const inLic = `${c.licenceId}_in`;
      const vKeyIn = mintVirtualKey();
      const keyIdIn = await sha256Hex(vKeyIn);
      await rpc.upsertDevice({
        licenceId: inLic,
        deviceId: "dev_1",
        keyId: keyIdIn,
        status: "active",
        plan: c.plan,
        periodEnd: FUTURE,
        notAfter: FUTURE,
        monthlyCapMicroUsd: 40_000_000,
        now: NOW,
      });
      const stubIn = env.LICENCE_METER!.get(env.LICENCE_METER!.idFromName(inLic)) as unknown as LicenceMeter;
      await stubIn.recordSpend({
        costMicroUsd: 100,
        tokens: c.inCap,
        inputTokens: c.inCap,
        outputTokens: 1_000,
        now: NOW,
      });
      const resIn = await handleChatCompletions(
        new Request("https://pro.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${vKeyIn}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MANAGED_MODEL_ALIAS, messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
        readConfig(env),
        NOW,
      );
      expect(resIn.status, `${c.plan} input cap`).toBe(429);
    }
  });

  it("returns 404 for removed public routes /api/apple-asn and /api/webhook/payment", async () => {
    const env: Env = { PRO_KV: fakeKv() };
    const r1 = await worker.fetch(new Request("https://pro.gestu.ca/api/apple-asn", { method: "POST" }), env);
    expect(r1.status).toBe(404);
    const r2 = await worker.fetch(new Request("https://pro.gestu.ca/api/webhook/payment", { method: "POST" }), env);
    expect(r2.status).toBe(404);
  });

  it("returns the split usage counters and tier ceilings entitlement-service builds response quota fields from", async () => {
    // `entitlement-service` maps `getUsage` into the client's `ProProvisionResponse` quota fields;
    // dropping `outputTokens`/`monthlyOutputTokenLimit` silently reported 0/0 to every licence
    // holder, so this pins the additive fields of the InternalApi RPC.
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "ca.gestu.app",
      UPSTREAM_API_KEY: "test-upstream-key",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);
    const rpc = new InternalApi({} as ExecutionContext, env);

    const keyId = await sha256Hex(mintVirtualKey());
    await rpc.upsertDevice({
      licenceId: "lic_usage",
      deviceId: "dev_usage",
      keyId,
      status: "active",
      plan: "gestu_pro_monthly",
      periodEnd: FUTURE,
      notAfter: FUTURE,
      monthlyCapMicroUsd: 10_000_000,
      now: NOW,
    });
    const stub = env.LICENCE_METER.get(env.LICENCE_METER.idFromName("lic_usage")) as unknown as LicenceMeter;
    await stub.recordSpend({
      costMicroUsd: 500,
      tokens: 12_500,
      inputTokens: 10_000,
      outputTokens: 2_500,
      now: NOW,
    });

    const usage = await rpc.getUsage({ licenceId: "lic_usage", now: NOW });
    expect(usage.periodId).toBe("2026-10");
    expect(usage.inputTokens).toBe(10_000);
    expect(usage.outputTokens).toBe(2_500);
    expect(usage.tier).toBe("pro");
    expect(usage.monthlyOutputTokenLimit).toBe(1_500_000);
    expect(usage.monthlyInputTokenLimit).toBe(100_000_000);
    // The older fields entitlement-service also reads are untouched.
    expect(usage.tokens).toBe(12_500);
    // 500 µUSD against the $10.00 soft cap = 50 ppm.
    expect(usage.usedPpm).toBe(50);
    expect(usage.mode).toBe("normal");
  });

  it("reports the Free tier's locked limits through getUsage for a gestu_free plan", async () => {
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "ca.gestu.app",
      UPSTREAM_API_KEY: "test-upstream-key",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);
    const rpc = new InternalApi({} as ExecutionContext, env);
    const keyId = await sha256Hex(mintVirtualKey());
    await rpc.upsertDevice({
      licenceId: "lic_free_usage",
      deviceId: "dev_free",
      keyId,
      status: "active",
      plan: "gestu_free",
      periodEnd: FUTURE,
      notAfter: FUTURE,
      monthlyCapMicroUsd: 0,
      now: NOW,
    });

    const usage = await rpc.getUsage({ licenceId: "lic_free_usage", now: NOW });
    expect(usage.tier).toBe("free");
    expect(usage.monthlyCapMicroUsd).toBe(500_000);
    expect(usage.monthlyOutputTokenLimit).toBe(200_000);
    expect(usage.monthlyInputTokenLimit).toBe(15_000_000);
    const freeStub = env.LICENCE_METER!.get(env.LICENCE_METER!.idFromName("lic_free_usage")) as unknown as LicenceMeter;
    const summary = await freeStub.getUsage(undefined, NOW);
    expect(summary.hardCapMicroUsd).toBe(500_000);
  });

  it("reports the Pro upstream balance as a numeric totalBalanceUsd for the daily alert", async () => {
    const env: Env = {
      PRO_KV: fakeKv(),
      UPSTREAM_API_KEY: "test-upstream-key",
      UPSTREAM_BASE_URL: "https://api.deepseek.com",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "USD", total_balance: "123.45", granted_balance: "0.00", topped_up_balance: "123.45" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const rpc = new InternalApi({} as ExecutionContext, env);
      const balance = await rpc.getUpstreamBalance();
      expect(balance.available).toBe(true);
      expect(typeof balance.totalBalanceUsd).toBe("number");
      expect(balance.totalBalanceUsd).toBe(123.45);
      expect(balance.currency).toBe("USD");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("invokes LicenceMeter RPC stubs without touching Function.prototype.call (Cloudflare RpcStub parity)", async () => {
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "app.gestu.assistant",
      UPSTREAM_API_KEY: "test-upstream-key",
    };

    const instances = new Map<string, LicenceMeter>();
    const createRpcProxyStub = (target: LicenceMeter): DurableObjectStub =>
      new Proxy(
        {},
        {
          get(_obj, prop) {
            if (typeof prop !== "string") return undefined;
            const candidate = (target as unknown as Record<string, unknown>)[prop];
            if (typeof candidate !== "function") return candidate;
            return new Proxy(() => {}, {
              apply(_fn, _thisArg, argArray) {
                return (candidate as (...args: unknown[]) => unknown).apply(target, argArray);
              },
              get(_fn, subProp) {
                if (subProp === "call" || subProp === "apply" || subProp === "bind") {
                  throw new TypeError(`The RPC receiver does not implement the method "${String(subProp)}".`);
                }
                return undefined;
              },
            });
          },
        },
      ) as unknown as DurableObjectStub;

    env.LICENCE_METER = {
      idFromName(name: string): DurableObjectId {
        return { toString: () => name, equals: (o: DurableObjectId) => o.toString() === name } as DurableObjectId;
      },
      get(id: DurableObjectId): DurableObjectStub {
        let inst = instances.get(id.toString());
        if (!inst) {
          inst = new LicenceMeter({} as DurableObjectState, env);
          instances.set(id.toString(), inst);
        }
        return createRpcProxyStub(inst);
      },
    } as unknown as DurableObjectNamespace;

    const rpc = new InternalApi({} as ExecutionContext, env);
    const keyId = await sha256Hex(mintVirtualKey());
    const up = await rpc.upsertDevice({
      licenceId: "lic_rpc_proxy",
      deviceId: "dev_rpc_1",
      keyId,
      status: "active",
      plan: "gestu_pro_monthly",
      periodEnd: FUTURE,
      notAfter: FUTURE,
      monthlyCapMicroUsd: 10_000_000,
      now: NOW,
    });
    expect(up.ok).toBe(true);

    const setRes = await rpc.setLicenceState({
      licenceId: "lic_rpc_proxy",
      status: "active",
      periodEnd: FUTURE,
      notAfter: FUTURE,
      plan: "gestu_pro_monthly",
      monthlyCapMicroUsd: 10_000_000,
      now: NOW,
    });
    expect(setRes.ok).toBe(true);

    const auth = await callLicenceMeter<{ allowed: boolean; leaseId?: string }>(
      env.LICENCE_METER,
      "lic_rpc_proxy",
      "authorizeRequest",
      { keyId, deviceId: "dev_rpc_1", now: NOW, acquireLease: true },
    );
    expect(auth.allowed).toBe(true);

    await callLicenceMeter(env.LICENCE_METER, "lic_rpc_proxy", "recordSpend", {
      costMicroUsd: 1_000,
      tokens: 500,
      inputTokens: 400,
      outputTokens: 100,
      leaseId: auth.leaseId,
      now: NOW,
    });

    await callLicenceMeter(env.LICENCE_METER, "lic_rpc_proxy", "releaseLease", {
      leaseId: auth.leaseId ?? "missing",
    });

    const usage = await rpc.getUsage({ licenceId: "lic_rpc_proxy", now: NOW });
    expect(usage.outputTokens).toBe(100);
    expect(usage.inputTokens).toBe(400);

    const rel = await rpc.releaseDevice({ licenceId: "lic_rpc_proxy", deviceId: "dev_rpc_1", now: NOW });
    expect(rel.ok).toBe(true);
  });

  it("enforces the $0.35 USD/month Free hard cap with PPM metering", async () => {
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "app.gestu.assistant",
      GESTU_PUBLIC_BASE_URL: "https://api.gestu.ca",
      UPSTREAM_API_KEY: "test-pro-upstream",
      GEMINI_FREE_API_KEY: "test-free-upstream",
      FREE_UPSTREAM_BASE_URL: "https://api.deepseek.com/v1",
      FREE_UPSTREAM_MODEL_ID: "deepseek-flash",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);

    // 1. Provision a Free key through the live DO path -> $0.50 (500_000 µUSD) hard & soft cap, PPM quota.
    const provRes = await worker.fetch(
      new Request("https://api.gestu.ca/api/provision-free-token", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.55" },
        body: JSON.stringify({ deviceId: "dev-free-dollar", packageName: "app.gestu.assistant", appVersion: "2.6.0" }),
      }),
      env,
    );
    expect(provRes.status).toBe(200);
    const provBody = (await provRes.json()) as {
      ok: boolean;
      virtualKey: string;
      plan: string;
      quotaUsed: number;
      quotaLimit: number;
      quotaMode: string;
    };
    expect(provBody.ok).toBe(true);
    expect(provBody.plan).toBe("free");
    expect(provBody.quotaUsed).toBe(0);
    expect(provBody.quotaLimit).toBe(1_000_000);
    expect(provBody.quotaMode).toBe("normal");

    // Verify the key record carries the $0.50 Free trial cap.
    const keyHash = await sha256Hex(provBody.virtualKey);
    const recordRaw = await kv.get(`key:${keyHash}`);
    const record = JSON.parse(recordRaw ?? "{}") as { licenceId?: string; monthlyCapMicroUsd?: number };
    expect(record.monthlyCapMicroUsd).toBe(500_000);
    const meterId = record.licenceId ?? "";
    expect(meterId).not.toBe("");
    const stub = env.LICENCE_METER!.get(env.LICENCE_METER!.idFromName(meterId)) as unknown as LicenceMeter;

    // Record $0.25 spend -> 500,000 ppm (50%), still allowed in normal mode.
    await stub.recordSpend({
      costMicroUsd: 250_000,
      tokens: 200_000,
      inputTokens: 100_000,
      outputTokens: 100_000,
      now: Date.now(),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-free-dollar",
          model: "deepseek-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 200, completion_tokens: 100, prompt_cache_hit_tokens: 150, prompt_cache_miss_tokens: 50 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const chatRes = await worker.fetch(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${provBody.virtualKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.55",
          },
          body: JSON.stringify({ model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hello" }] }),
        }),
        env,
      );
      expect(chatRes.status).toBe(200);
      expect(chatRes.headers.get("X-Gestu-Quota-Unit")).toBe("ppm");
      expect(chatRes.headers.get("X-Gestu-Quota-Mode")).toBe("normal");
      expect(chatRes.headers.get("X-Gestu-Quota-Limit")).toBe("1000000");
      expect(Number(chatRes.headers.get("X-Gestu-Quota-Used"))).toBe(500_000);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Subscription status endpoint reports Free + PPM + 1,000,000 limit without fake token cutoffs.
    const statusRes = await worker.fetch(
      new Request("https://api.gestu.ca/api/subscription-status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ virtualKey: provBody.virtualKey, deviceId: "dev-free-dollar" }),
      }),
      env,
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      plan: string;
      quotaUnit: string;
      limitTokens: number;
      usedTokens: number;
    };
    expect(statusBody.plan).toBe("free");
    expect(statusBody.quotaUnit).toBe("ppm");
    expect(statusBody.limitTokens).toBe(1_000_000);
    expect(statusBody.usedTokens).toBeGreaterThanOrEqual(500_000);

    // Push spend to $0.50 USD -> sharp hard shutoff (429 quota_exceeded) with no hardcoded Pro text or token numbers.
    await stub.recordSpend({
      costMicroUsd: 250_000,
      tokens: 1_000,
      inputTokens: 500,
      outputTokens: 500,
      now: Date.now(),
    });
    const blockedRes = await worker.fetch(
      new Request("https://api.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${provBody.virtualKey}`,
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.55",
        },
        body: JSON.stringify({ model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "blocked" }] }),
      }),
      env,
    );
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers.get("X-Gestu-Quota-Unit")).toBe("ppm");
    expect(blockedRes.headers.get("X-Gestu-Quota-Limit")).toBe("1000000");
    expect(Number(blockedRes.headers.get("X-Gestu-Quota-Used"))).toBeGreaterThanOrEqual(1_000_000);
    const blockedBody = (await blockedRes.json()) as { error: { code: string; message: string } };
    expect(blockedBody.error.code).toBe("quota_exceeded");
    expect(blockedBody.error.message).toContain("Gestu Free");
    expect(blockedBody.error.message).not.toContain("Gestu Pro");
    expect(blockedBody.error.message).not.toContain("200000");

    // 2. A Free device stored with an older cap (the previous $1.00 budget) follows the current
    //    $0.50 Free trial budget without re-provisioning.
    const rpc = new InternalApi({} as ExecutionContext, env);
    const legacyKeyId = await sha256Hex(mintVirtualKey());
    await rpc.upsertDevice({
      licenceId: "lic_free_legacy_dollar",
      deviceId: "dev_legacy",
      keyId: legacyKeyId,
      status: "active",
      plan: "gestu_free",
      periodEnd: 0,
      notAfter: 0,
      monthlyCapMicroUsd: 1_000_000,
      now: NOW,
    });
    const legacyStub = env.LICENCE_METER!.get(env.LICENCE_METER!.idFromName("lic_free_legacy_dollar")) as unknown as LicenceMeter;
    await legacyStub.recordSpend({ costMicroUsd: 400_000, tokens: 10_000, inputTokens: 5_000, outputTokens: 5_000, now: NOW });
    const legacyUsage = await legacyStub.getUsage(undefined, NOW);
    expect(legacyUsage.monthlyCapMicroUsd).toBe(500_000);
    expect(legacyUsage.hardCapMicroUsd).toBe(500_000);
    expect(legacyUsage.usedPpm).toBe(800_000);
    expect(legacyUsage.exhausted).toBe(false);
  });
});

async function callLicenceMeterDirect(
  ns: DurableObjectNamespace | undefined,
  licenceId: string,
  costMicroUsd: number,
  tokens: number,
  now: number,
): Promise<void> {
  if (!ns) return;
  const stub = ns.get(ns.idFromName(licenceId)) as unknown as LicenceMeter;
  await stub.recordSpend({ costMicroUsd, tokens, now });
}

describe("Free/Pro abuse guards in the LicenceMeter", () => {
  const NOW = Date.UTC(2026, 9, 15, 14, 0, 0);
  const FUTURE = NOW + 30 * 86_400_000;
  function meterEnv(): Env {
    const env: Env = {
      PRO_KV: fakeKv(),
      GESTU_ALLOWED_PACKAGE_NAMES: "app.gestu.assistant",
      GESTU_PUBLIC_BASE_URL: "https://api.gestu.ca",
      UPSTREAM_API_KEY: "test-pro-upstream",
      GEMINI_FREE_API_KEY: "test-free-upstream",
      FREE_UPSTREAM_BASE_URL: "https://api.deepseek.com/v1",
      FREE_UPSTREAM_MODEL_ID: "deepseek-flash",
    };
    env.LICENCE_METER = createFakeLicenceMeterNamespace(env);
    return env;
  }

  async function meterFor(env: Env, licenceId: string, plan: string, deviceLimit?: number): Promise<LicenceMeter> {
    const rpc = new InternalApi({} as ExecutionContext, env);
    await rpc.upsertDevice({
      licenceId,
      deviceId: `${licenceId}-dev`,
      keyId: await sha256Hex(mintVirtualKey()),
      status: "active",
      plan,
      periodEnd: FUTURE,
      notAfter: FUTURE,
      monthlyCapMicroUsd: 0,
      ...(deviceLimit ? { deviceLimit } : {}),
      now: NOW,
    });
    return env.LICENCE_METER!.get(env.LICENCE_METER!.idFromName(licenceId)) as unknown as LicenceMeter;
  }

  it("allows 2 simultaneous streams per Free device and refuses the third instead of evicting", async () => {
    const env = meterEnv();
    const meter = await meterFor(env, "free-streams", "gestu_free");
    const a = await meter.authorizeRequest({ keyId: "k", now: NOW });
    const b = await meter.authorizeRequest({ keyId: "k", now: NOW });
    const c = await meter.authorizeRequest({ keyId: "k", now: NOW });
    expect(a.allowed && b.allowed).toBe(true);
    expect(c.allowed).toBe(false);
    if (!c.allowed) expect(c.httpStatus).toBe(429);

    // Finishing a stream frees its slot.
    if (a.allowed) await meter.releaseLease(a.leaseId);
    const d = await meter.authorizeRequest({ keyId: "k", now: NOW });
    expect(d.allowed).toBe(true);
  });

  it("allows 12 simultaneous streams per Pro device seat", async () => {
    const env = meterEnv();
    const meter = await meterFor(env, "pro-streams", "gestu_pro_monthly", 1);
    for (let i = 0; i < 12; i += 1) {
      expect((await meter.authorizeRequest({ keyId: "k", now: NOW })).allowed, `stream ${i}`).toBe(true);
    }
    expect((await meter.authorizeRequest({ keyId: "k", now: NOW })).allowed).toBe(false);
  });

  it("does NOT trip at $25/day for normal trial traffic, and only pauses at the high emergency abuse guardrail ($500/day)", async () => {
    const env = meterEnv();
    const prov = await worker.fetch(
      new Request("https://api.gestu.ca/api/provision-free-token", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
        body: JSON.stringify({ deviceId: "dev-global-cap", packageName: "app.gestu.assistant", appVersion: "2.6.0" }),
      }),
      env,
    );
    const { virtualKey } = (await prov.json()) as { virtualKey: string };

    const global = env.LICENCE_METER!.get(env.LICENCE_METER!.idFromName("global:free-spend")) as unknown as LicenceMeter;
    const today = new Date().toISOString().slice(0, 10);

    // $150/day (300 testers * $0.50) must NOT lock out legitimate signups.
    await global.addGlobalSpend(today, 150_000_000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-ok",
          model: "deepseek-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const okRes = await worker.fetch(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${virtualKey}`, "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
          body: JSON.stringify({ model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
      );
      expect(okRes.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Crossing the $500/day emergency abuse guardrail trips 503 free_capacity_reached.
    await global.addGlobalSpend(today, 350_000_000);
    const res = await worker.fetch(
      new Request("https://api.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${virtualKey}`, "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
        body: JSON.stringify({ model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
    );
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("free_capacity_reached");
    expect(body.error.message).toMatch(/busy/i);

    // Explicit disable ("off") bypasses the emergency guardrail.
    env.GESTU_FREE_EMERGENCY_DAILY_CAP_USD = "off";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-off",
          model: "deepseek-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const offRes = await worker.fetch(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${virtualKey}`, "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
          body: JSON.stringify({ model: FREE_MANAGED_MODEL_ID, messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
      );
      expect(offRes.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
