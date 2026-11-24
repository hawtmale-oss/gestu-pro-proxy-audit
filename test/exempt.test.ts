import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/base64";
import type { Env } from "../src/config";
import { FREE_PROVISION_PATH } from "../src/constants";
import { deviceKey, isExemptDevice, isExemptIp, isExemptRequest, matchesOperatorKey } from "../src/exempt";
import worker from "../src/index";
import { findKeyByVirtualKey } from "../src/store";
import { fakeKv } from "./fake-kv";

/**
 * Operator exemptions: an allow-listed device or network is authenticated like any other caller but
 * is never refused for capacity. These tests pin the two halves that matter — the predicate, and
 * the one refusal that blocked the owner's own phone (the per-IP new-device cap).
 */
const NOW_IP = "203.0.113.30";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PRO_KV: fakeKv(),
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

function freeTokenRequest(deviceId: string, ip = NOW_IP): Request {
  return new Request(`https://api.gestu.ca${FREE_PROVISION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ deviceId, packageName: "app.gestu.assistant", appVersion: "2.6.3" }),
  });
}

describe("operator exemptions", () => {
  const deviceId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

  it("matches a hashed device id, case- and space-insensitively", async () => {
    const env = makeEnv({ GESTU_UNLIMITED_DEVICE_HASHES: ` ${(await sha256Hex(deviceId)).toUpperCase()} ` });
    expect(await isExemptDevice(env, deviceId)).toBe(true);
    expect(await isExemptDevice(env, `  ${deviceId}  `)).toBe(true);
    expect(await isExemptDevice(env, "another-device")).toBe(false);
    expect(await isExemptDevice(env, "")).toBe(false);
    expect(await isExemptDevice(env, null)).toBe(false);
  });

  it("changes nothing when neither list is configured", async () => {
    const env = makeEnv();
    expect(await isExemptDevice(env, deviceId)).toBe(false);
    expect(await isExemptIp(env, NOW_IP)).toBe(false);
  });

  it("matches an exempt address", async () => {
    const env = makeEnv({ GESTU_UNLIMITED_IPS: NOW_IP });
    expect(await isExemptIp(env, NOW_IP)).toBe(true);
    expect(await isExemptIp(env, "203.0.113.31")).toBe(false);
    expect(await isExemptIp(env, "")).toBe(false);
  });

  it("answers for the request when either handle matches", async () => {
    const byDevice = makeEnv({ GESTU_UNLIMITED_DEVICE_HASHES: await sha256Hex(deviceId) });
    const byIp = makeEnv({ GESTU_UNLIMITED_IPS: NOW_IP });
    expect(await isExemptRequest(byDevice, deviceId, "198.51.100.7")).toBe(true);
    expect(await isExemptRequest(byIp, "unrelated", NOW_IP)).toBe(true);
    expect(await isExemptRequest(makeEnv(), deviceId, NOW_IP)).toBe(false);
  });

  it("still caps concurrent devices per IP when nothing is exempt", async () => {
    const env = makeEnv();
    const first = (await (await worker.fetch(freeTokenRequest("cap-dev-1"), env)).json()) as {
      virtualKey?: string;
    };
    expect((await worker.fetch(freeTokenRequest("cap-dev-2"), env)).status).toBe(200);
    // The cap bounds concurrent trial devices, not admissions: with nothing exempt the third
    // replaces the oldest permission rather than being refused.
    const third = await worker.fetch(freeTokenRequest("cap-dev-3"), env);
    expect(third.status).toBe(200);
    expect(await findKeyByVirtualKey(env.PRO_KV, first.virtualKey!)).toBeNull();
  });

  it("lets an exempt device past the per-IP new-device cap", async () => {
    const thirdDevice = "cap-dev-3";
    const env = makeEnv({ GESTU_UNLIMITED_DEVICE_HASHES: await sha256Hex(thirdDevice) });
    expect((await worker.fetch(freeTokenRequest("cap-dev-1"), env)).status).toBe(200);
    expect((await worker.fetch(freeTokenRequest("cap-dev-2"), env)).status).toBe(200);
    const third = await worker.fetch(freeTokenRequest(thirdDevice), env);
    expect(third.status).toBe(200);
    expect(((await third.json()) as { ok?: boolean }).ok).toBe(true);
  });

  it("lets an exempt network past the same cap", async () => {
    const env = makeEnv({ GESTU_UNLIMITED_IPS: NOW_IP });
    expect((await worker.fetch(freeTokenRequest("net-dev-1"), env)).status).toBe(200);
    expect((await worker.fetch(freeTokenRequest("net-dev-2"), env)).status).toBe(200);
    expect((await worker.fetch(freeTokenRequest("net-dev-3"), env)).status).toBe(200);
  });
});

describe("/admin/exempt", () => {
  const key = "gop_admin_suite_key";

  function post(body: unknown, authorization = `Bearer ${key}`): Request {
    return new Request("https://api.gestu.ca/admin/exempt", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(body),
    });
  }

  it("stores and removes a device entry without a redeploy", async () => {
    const env = makeEnv({ GESTU_UNLIMITED_KEY: key });
    const id = "admin-exempt-device-1";
    const stored = deviceKey(await sha256Hex(id));

    expect(await env.PRO_KV.get(stored)).toBeNull();
    expect((await worker.fetch(post({ deviceIds: [id] }), env)).status).toBe(200);
    expect(await env.PRO_KV.get(stored)).not.toBeNull();

    expect((await worker.fetch(post({ deviceIds: [id], remove: true }), env)).status).toBe(200);
    expect(await env.PRO_KV.get(stored)).toBeNull();
  });

  it("refuses a call without the operator credential", async () => {
    const env = makeEnv({ GESTU_UNLIMITED_KEY: key });
    expect((await worker.fetch(post({ deviceIds: ["x"] }, "Bearer nope"), env)).status).toBe(401);
    expect((await worker.fetch(post({ deviceIds: ["x"] }, ""), env)).status).toBe(401);
  });
});

describe("operator master key", () => {
  const key = "gop_test_key_for_the_suite_only";

  it("matches the configured key, tolerating surrounding whitespace", async () => {
    expect(await matchesOperatorKey(makeEnv({ GESTU_UNLIMITED_KEY: `  ${key}  ` }), key)).toBe(true);
  });
  it("rejects a wrong, empty or unconfigured key", async () => {
    expect(await matchesOperatorKey(makeEnv({ GESTU_UNLIMITED_KEY: key }), `${key}x`)).toBe(false);
    expect(await matchesOperatorKey(makeEnv({ GESTU_UNLIMITED_KEY: key }), "")).toBe(false);
    expect(await matchesOperatorKey(makeEnv(), key)).toBe(false);
  });
});
