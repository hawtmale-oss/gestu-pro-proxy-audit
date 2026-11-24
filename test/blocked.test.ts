import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/base64";
import type { Env } from "../src/config";
import { FREE_PROVISION_PATH } from "../src/constants";
import { blockedDeviceKey, isBlockedDevice, isBlockedRequest, resetBlockCache } from "../src/blocked";
import worker from "../src/index";
import { fakeKv } from "./fake-kv";

/**
 * Ban list: a banned device is refused at provisioning and on inference, so revoking its key is not
 * something it can undo by re-installing. The predicate and the two enforcement points are what
 * matter; the admin route is exercised through them.
 */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PRO_KV: fakeKv(),
    LICENCE_METER: {} as DurableObjectNamespace,
    GESTU_ALLOWED_PACKAGE_NAMES: "app.gestu.assistant,app.gestu.assistant.foss",
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

const IP = "203.0.113.77";

function freeTokenRequest(deviceId: string, ip = IP): Request {
  return new Request(`https://api.gestu.ca${FREE_PROVISION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ deviceId, packageName: "app.gestu.assistant", appVersion: "2.6.6" }),
  });
}

describe("ban list", () => {
  it("matches a banned device hash and a banned address", async () => {
    const deviceId = "ban-device-1";
    const env = makeEnv();
    await env.PRO_KV.put(blockedDeviceKey(await sha256Hex(deviceId)), "1");
    await env.PRO_KV.put("blocked:ip:203.0.113.99", "1");

    expect(await isBlockedDevice(env, deviceId)).toBe(true);
    expect(await isBlockedRequest(env, deviceId, "198.51.100.1")).toBe(true);
    expect(await isBlockedRequest(env, "someone-else", "203.0.113.99")).toBe(true);
    expect(await isBlockedRequest(env, "someone-else", "198.51.100.1")).toBe(false);
    expect(await isBlockedDevice(env, "")).toBe(false);
  });

  it("refuses a banned device at provisioning, so it cannot mint a fresh key", async () => {
    const deviceId = "ban-device-2";
    const env = makeEnv();
    await env.PRO_KV.put(blockedDeviceKey(await sha256Hex(deviceId)), "1");

    const res = await worker.fetch(freeTokenRequest(deviceId), env);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { reason?: string }).reason).toBe("revoked");
  });

  it("refuses inference for a device banned after it already holds a key", async () => {
    const deviceId = "ban-device-3";
    const env = makeEnv();
    const token = (await (await worker.fetch(freeTokenRequest(deviceId), env)).json()) as {
      virtualKey: string;
    };
    await env.PRO_KV.put(blockedDeviceKey(await sha256Hex(deviceId)), "1");
    // The provisioning check above cached a miss for this device; drop it so the ban is visible.
    resetBlockCache();
    expect(await isBlockedDevice(env, deviceId)).toBe(true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();
    try {
      const res = await worker.fetch(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.virtualKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": IP,
          },
          body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        }),
        env,
      );
      expect(res.status).toBe(401);
      expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
