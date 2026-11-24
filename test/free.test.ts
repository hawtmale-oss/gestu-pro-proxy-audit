import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/base64";
import type { Env } from "../src/config";
import {
  FREE_CHAT_RATE_LIMIT,
  FREE_IP_CHAT_RATE_LIMIT,
  FREE_MONTHLY_OUTPUT_TOKENS,
  FREE_PROVISION_RATE_LIMIT,
  FREE_PROVISION_PATH,
} from "../src/constants";
import { freeMeterIdForDevice } from "../src/free";
import worker from "../src/index";
import { recordTierUsage } from "../src/quota";
import { findKeyByVirtualKey, getKeyRecord } from "../src/store";
import { fakeKv } from "./fake-kv";

/**
 * The Free managed route's contract, pinned to the Kotlin client:
 * `ProCatalog.PROVISION_FREE_PATH` (`/api/provision-free-token`), body `ProFreeTokenRequest`
 * (`{deviceId, packageName, appVersion}`), answer `ProProvisionResponse` fields.
 */
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PRO_KV: fakeKv(),
    // Present in a real deployment (the LicenceMeter class binding); health uses it to decide a
    // licence-only deployment is configured rather than unconfigured.
    LICENCE_METER: {} as DurableObjectNamespace,
    GESTU_ALLOWED_PACKAGE_NAMES: "app.gestu.assistant,app.gestu.assistant.foss,app.gestu.assistant.windows",
    GESTU_PUBLIC_BASE_URL: "https://api.gestu.ca",
    UPSTREAM_API_KEY: "test-pro-upstream",
    UPSTREAM_BASE_URL: "https://api.deepseek.com",
    UPSTREAM_MODEL_ID: "deepseek-flash",
    GEMINI_FREE_API_KEY: "test-free-upstream",
    FREE_UPSTREAM_BASE_URL: "https://api.deepseek.com/v1",
    FREE_UPSTREAM_MODEL_ID: "deepseek-flash",
    ...overrides,
  };
}

function freeTokenRequest(deviceId: string, packageName = "app.gestu.assistant", ip = "203.0.113.30"): Request {
  return new Request(`https://api.gestu.ca${FREE_PROVISION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ deviceId, packageName, appVersion: "2.5.2" }),
  });
}

interface FreeTokenBody {
  ok: boolean;
  virtualKey: string;
  proxyBaseUrl: string;
  expiresAt: number;
  plan: string;
  status: string;
  quotaPeriod: string;
  quotaUsed: number;
  quotaLimit: number;
  quotaRenewsAt: number;
  quotaMode: string;
  devicesUsed: number;
  deviceLimit: number;
  reason: string;
  message: string;
}

describe("POST /api/provision-free-token", () => {
  it("mints a device-bound Free key in the client's exact response shape", async () => {
    const env = makeEnv();
    const res = await worker.fetch(freeTokenRequest("dev-free-1"), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FreeTokenBody;

    expect(body.ok).toBe(true);
    expect(body.virtualKey.startsWith("gsk_")).toBe(true);
    expect(body.proxyBaseUrl).toBe("https://api.gestu.ca/v1");
    expect(body.plan).toBe("free");
    expect(body.status).toBe("active");
    expect(body.quotaLimit).toBe(FREE_MONTHLY_OUTPUT_TOKENS);
    expect(body.quotaUsed).toBe(0);
    expect(body.quotaMode).toBe("normal");
    expect(body.quotaPeriod).toMatch(/^\d{4}-\d{2}$/);
    expect(body.quotaRenewsAt).toBeGreaterThan(Date.now() - 1);
    expect(body.devicesUsed).toBe(1);
    expect(body.deviceLimit).toBe(1);

    const record = await findKeyByVirtualKey(env.PRO_KV, body.virtualKey);
    expect(record).not.toBeNull();
    expect(record?.productId).toBe("gestu_free");
    expect(record?.status).toBe("active");
    // Per-user 7-day trial window is set on first provision.
    expect(record?.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(record?.expiresAt).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000 + 5_000);
    expect(body.expiresAt).toBe(record?.expiresAt);
    expect(record?.meterId).toBe(await freeMeterIdForDevice("dev-free-1"));

    // No provider key is anywhere in the answer.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const needle of ["gemini", "deepseek", "generativelanguage", "api key"]) {
      expect(serialized).not.toContain(needle);
    }
  });

  it("rotates the secret on re-provision but keeps the device's meter id, so the month does not reset", async () => {
    const env = makeEnv();
    const first = (await (await worker.fetch(freeTokenRequest("dev-free-2"), env)).json()) as FreeTokenBody;
    const firstRecord = await findKeyByVirtualKey(env.PRO_KV, first.virtualKey);
    expect(firstRecord).not.toBeNull();

    const second = (await (await worker.fetch(freeTokenRequest("dev-free-2"), env)).json()) as FreeTokenBody;
    expect(second.ok).toBe(true);
    expect(second.virtualKey).not.toBe(first.virtualKey);
    expect(second.quotaLimit).toBe(FREE_MONTHLY_OUTPUT_TOKENS);

    const secondRecord = await findKeyByVirtualKey(env.PRO_KV, second.virtualKey);
    expect(secondRecord).not.toBeNull();
    // Same device → same stable meter id; new secret → new key id.
    expect(secondRecord?.meterId).toBe(firstRecord?.meterId);
    expect(secondRecord?.keyId).not.toBe(firstRecord?.keyId);
    // The superseded secret stops authenticating.
    expect(await findKeyByVirtualKey(env.PRO_KV, first.virtualKey)).toBeNull();
  });

  it("carries the device's used output tokens across a reinstall", async () => {
    const env = makeEnv();
    const first = (await (await worker.fetch(freeTokenRequest("dev-free-3"), env)).json()) as FreeTokenBody;
    const meterId = await freeMeterIdForDevice("dev-free-3");
    await recordTierUsage(env.PRO_KV, meterId, 1_000, 12_345, NOW);

    const second = (await (await worker.fetch(freeTokenRequest("dev-free-3"), env)).json()) as FreeTokenBody;
    expect(second.quotaUsed).toBe(12_345);
    expect(second.quotaLimit).toBe(FREE_MONTHLY_OUTPUT_TOKENS);
    expect(first.virtualKey).not.toBe(second.virtualKey);
  });

  it("refuses a malformed body, a missing device id, and a spoofed package name", async () => {
    const env = makeEnv();

    const notJson = await worker.fetch(
      new Request(`https://api.gestu.ca${FREE_PROVISION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      env,
    );
    expect(notJson.status).toBe(400);

    const noDevice = await worker.fetch(
      new Request(`https://api.gestu.ca${FREE_PROVISION_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.31" },
        body: JSON.stringify({ packageName: "app.gestu.assistant" }),
      }),
      env,
    );
    expect(noDevice.status).toBe(400);

    const spoofed = (await (
      await worker.fetch(freeTokenRequest("dev-free-4", "evil.example.app", "203.0.113.32"), env)
    ).json()) as FreeTokenBody;
    expect(spoofed.ok).toBe(false);
    expect(spoofed.reason).toBe("not_verified");
    expect(spoofed.virtualKey).toBe("");

    const emptyPackage = (await (
      await worker.fetch(freeTokenRequest("dev-free-empty-pkg", "", "203.0.113.32"), env)
    ).json()) as FreeTokenBody;
    expect(emptyPackage.ok).toBe(false);
    expect(emptyPackage.reason).toBe("not_verified");
  });

  it("throttles datacenter ASN provisioning to 2/hr per IP and blocks low bot scores", async () => {
    const env = makeEnv();
    const dcIp = "198.51.100.77";
    const makeDcReq = (devId: string, score = 50): Request => {
      const req = freeTokenRequest(devId, "app.gestu.assistant", dcIp);
      Object.defineProperty(req, "cf", {
        value: { asOrganization: "Amazon.com, Inc. (AWS)", botManagement: { score } },
      });
      return req;
    };

    expect((await worker.fetch(makeDcReq("dc-dev-1"), env)).status).toBe(200);
    expect((await worker.fetch(makeDcReq("dc-dev-2"), env)).status).toBe(200);
    const thirdDc = await worker.fetch(makeDcReq("dc-dev-3"), env);
    expect(thirdDc.status).toBe(429);

    const botReq = makeDcReq("bot-dev-1", 3);
    const botRes = await worker.fetch(botReq, env);
    expect(botRes.status).toBe(429);
  });

  it("rate limits provisioning per IP+device with a 429 and Retry-After", async () => {
    const env = makeEnv();
    const res: Response[] = [];
    for (let index = 0; index <= FREE_PROVISION_RATE_LIMIT; index += 1) {
      res.push(await worker.fetch(freeTokenRequest("dev-free-5", "app.gestu.assistant", "203.0.113.33"), env));
    }
    for (let index = 0; index < FREE_PROVISION_RATE_LIMIT; index += 1) {
      expect(res[index]?.status, `request ${index}`).toBe(200);
    }
    const limited = res[FREE_PROVISION_RATE_LIMIT]!;
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await limited.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("rate_limited");

    // A different device on the same IP is a different budget.
    const otherDevice = await worker.fetch(freeTokenRequest("dev-free-6", "app.gestu.assistant", "203.0.113.33"), env);
    expect(otherDevice.status).toBe(200);
  });

  it("fails closed when the rate-limit counter cannot be read", async () => {
    const brokenKv = {
      ...fakeKv(),
      get: async () => {
        throw new Error("KV unavailable");
      },
      put: async () => {
        throw new Error("KV unavailable");
      },
    } as unknown as Env["PRO_KV"];
    const env = makeEnv({ PRO_KV: brokenKv });
    const res = await worker.fetch(freeTokenRequest("dev-free-7", "app.gestu.assistant", "203.0.113.34"), env);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("keeps two new Free devices per IP, replacing the oldest permission", async () => {
    const env = makeEnv();
    const ip = "203.0.113.99";
    const first = (await (
      await worker.fetch(freeTokenRequest("rotating-dev-0", "app.gestu.assistant", ip), env)
    ).json()) as FreeTokenBody;
    const second = (await (
      await worker.fetch(freeTokenRequest("rotating-dev-1", "app.gestu.assistant", ip), env)
    ).json()) as FreeTokenBody;
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // A third new device replaces the oldest permission instead of being refused.
    const third = (await (
      await worker.fetch(freeTokenRequest("rotating-dev-new", "app.gestu.assistant", ip), env)
    ).json()) as FreeTokenBody;
    expect(third.ok).toBe(true);

    expect(await findKeyByVirtualKey(env.PRO_KV, first.virtualKey)).toBeNull();
    expect(await findKeyByVirtualKey(env.PRO_KV, second.virtualKey)).not.toBeNull();
    expect(await findKeyByVirtualKey(env.PRO_KV, third.virtualKey)).not.toBeNull();

    // A device that already holds a live Free key (reinstall, key rotation) is never counted and
    // never evicts another device.
    const again = (await (
      await worker.fetch(freeTokenRequest("rotating-dev-new", "app.gestu.assistant", ip), env)
    ).json()) as FreeTokenBody;
    expect(again.ok).toBe(true);
    expect(await findKeyByVirtualKey(env.PRO_KV, second.virtualKey)).not.toBeNull();
  });

  it("honours GESTU_FREE_DEVICES_PER_IP_MONTH, replacing the oldest when full", async () => {
    const env = makeEnv({ GESTU_FREE_DEVICES_PER_IP_MONTH: "4" } as Partial<Env>);
    const ip = "203.0.113.98";
    const keys: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const body = (await (
        await worker.fetch(freeTokenRequest(`cgnat-dev-${i}`, "app.gestu.assistant", ip), env)
      ).json()) as FreeTokenBody;
      expect(body.ok, `device ${i}`).toBe(true);
      keys.push(body.virtualKey);
    }
    const fifth = (await (
      await worker.fetch(freeTokenRequest("cgnat-dev-4", "app.gestu.assistant", ip), env)
    ).json()) as FreeTokenBody;
    expect(fifth.ok).toBe(true);
    expect(await findKeyByVirtualKey(env.PRO_KV, keys[0]!)).toBeNull();
    expect(await findKeyByVirtualKey(env.PRO_KV, keys[3]!)).not.toBeNull();
  });
});

describe("Free managed inference through the same /v1 surface", () => {
  it("provisions a Free key and uses it to reach the Free upstream with the app's public model id", async () => {
    const env = makeEnv();
    const token = (await (await worker.fetch(freeTokenRequest("dev-free-chat"), env)).json()) as FreeTokenBody;
    expect(token.ok).toBe(true);

    let upstreamUrl = "";
    let upstreamAuth = "";
    let upstreamBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      upstreamAuth = new Headers(init?.headers).get("authorization") ?? "";
      upstreamBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-free",
          model: "gemini-3.5-flash-lite",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello" } }],
          usage: { prompt_tokens: 40, completion_tokens: 25 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      const res = await worker.fetch(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.virtualKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.40",
          },
          body: JSON.stringify({
            model: "gemini-3.5-flash-lite",
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "what is this?" },
                  { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                ],
              },
            ],
          }),
        }),
        env,
      );

      expect(res.status).toBe(200);
      expect(upstreamUrl).toContain("api.deepseek.com");
      expect(upstreamAuth).toBe("Bearer test-free-upstream");
      expect(upstreamBody["model"]).toBe("deepseek-flash");
      // Media attachments are unlocked on Free (no Lite upsell exists any more).
      expect(upstreamBody["messages"]).toBeDefined();
      const payload = (await res.json()) as { model: string };
      expect(payload.model).toBe("gemini-3.5-flash-lite");
      expect(res.headers.get("X-Gestu-Quota-Limit")).toBe(String(FREE_MONTHLY_OUTPUT_TOKENS));

      // The turn was metered against the device's stable meter id.
      const meterId = await freeMeterIdForDevice("dev-free-chat");
      const record = await getKeyRecord(env.PRO_KV, await sha256Hex(token.virtualKey));
      expect(record).not.toBeNull();
      expect(record?.meterId).toBe(meterId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("refuses KV exhaustion at the fallback output safety cap", async () => {
    const env = makeEnv();
    const token = (await (await worker.fetch(freeTokenRequest("dev-free-cap"), env)).json()) as FreeTokenBody;
    await recordTierUsage(env.PRO_KV, await freeMeterIdForDevice("dev-free-cap"), 500, FREE_MONTHLY_OUTPUT_TOKENS, NOW);

    const res = await worker.fetch(
      new Request("https://api.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.virtualKey}`,
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.41",
        },
        body: JSON.stringify({ model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "hi" }] }),
      }),
      env,
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Gestu Free");
    expect(body.error.message.toLowerCase()).not.toContain("gemini");
  });

  it("rate limits a single IP+device to the per-minute Free chat ceiling", async () => {
    const env = makeEnv();
    const token = (await (await worker.fetch(freeTokenRequest("dev-free-chat-limit"), env)).json()) as FreeTokenBody;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-free",
            model: "gemini-3.5-flash-lite",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const call = (): Promise<Response> =>
      worker.fetch(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.virtualKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.42",
          },
          body: JSON.stringify({ model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
      );
    try {
      for (let index = 0; index < FREE_CHAT_RATE_LIMIT; index += 1) {
        expect((await call()).status, `request ${index}`).toBe(200);
      }
      const limited = await call();
      expect(limited.status).toBe(429);
      expect((await limited.json() as { error: { code: string } }).error.code).toBe("rate_limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps Free inference across rotating deviceIds from a single IP", async () => {
    const env = makeEnv();
    const ip = "203.0.113.88";
    const keys: string[] = [];
    for (let d = 0; d < 4; d += 1) {
      // Keys come from different networks (the new-device-per-IP limit is tested on its own);
      // the chat below is all from one IP, which is what this test is about.
      const tok = (await (await worker.fetch(freeTokenRequest(`chat-rot-dev-${d}`, "app.gestu.assistant", `198.51.100.${10 + d}`), env)).json()) as FreeTokenBody;
      keys.push(tok.virtualKey);
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-free",
            model: "gemini-3.5-flash-lite",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    try {
      for (let i = 0; i < FREE_IP_CHAT_RATE_LIMIT; i += 1) {
        // Round-robin, not i/25: the point is that the IP ceiling still binds however the
        // per-request allowance is spread across devices. Each key now takes a quarter of the
        // attempts, which keeps every one of them under its own per-device ceiling.
        const key = keys[i % keys.length]!;
        const res = await worker.fetch(
          new Request("https://api.gestu.ca/v1/chat/completions", {
            method: "POST",
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              "cf-connecting-ip": ip,
            },
            body: JSON.stringify({ model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "hi" }] }),
          }),
          env,
        );
        expect(res.status, `chat request ${i}`).toBe(200);
      }
      const blocked = await worker.fetch(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${keys[3]!}`,
            "content-type": "application/json",
            "cf-connecting-ip": ip,
          },
          body: JSON.stringify({ model: "gemini-3.5-flash-lite", messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
      );
      expect(blocked.status).toBe(429);
      expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("GET /health", () => {
  it("reports both managed tiers configured, the Free limiter, and no secret values", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://api.gestu.ca/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      checks: Record<string, boolean>;
      monthlyTokenLimit: number;
      freeMonthlyOutputTokenLimit: number;
      proxyBaseUrl: string;
    };
    expect(body.ok).toBe(true);
    expect(body.checks["proUpstreamKey"]).toBe(true);
    expect(body.checks["freeUpstreamKey"]).toBe(true);
    expect(body.checks["freeRateLimiter"]).toBe(false); // not bound in the unit-test env
    expect(body.monthlyTokenLimit).toBe(101_500_000);
    expect(body.freeMonthlyOutputTokenLimit).toBe(FREE_MONTHLY_OUTPUT_TOKENS);
    expect(body.proxyBaseUrl).toBe("https://api.gestu.ca/v1");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("test-upstream");
    expect(serialized).not.toContain("test-free-upstream");
  });

  it("fails closed (503) when either managed upstream secret is missing", async () => {
    for (const overrides of [{ GEMINI_FREE_API_KEY: undefined }, { UPSTREAM_API_KEY: undefined, DEEPSEEK_API_KEY: undefined }]) {
      const res = await worker.fetch(
        new Request("https://api.gestu.ca/health"),
        makeEnv(overrides as Partial<Env>),
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; degraded: string[] };
      expect(body.ok).toBe(false);
      expect(body.degraded.length).toBeGreaterThan(0);
    }
  });
});

describe("removed public routes stay 404 (never a 405 or an empty 200)", () => {
  it("answers 404 for the retired Apple App Store Server Notification and Stripe webhook paths", async () => {
    const env = makeEnv();
    for (const path of ["/api/apple-asn", "/api/webhook/payment"]) {
      for (const method of ["POST", "GET"]) {
        const res = await worker.fetch(new Request(`https://api.gestu.ca${path}`, { method }), env);
        expect(res.status, `${method} ${path}`).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("not_found");
      }
    }
  });

  it("answers 405 for a known path with the wrong method", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://api.gestu.ca/v1/chat/completions", { method: "GET" }), env);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("POST");
  });
});
