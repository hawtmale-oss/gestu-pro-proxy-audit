import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/base64";
import type { Env } from "../src/config";
import { readConfig } from "../src/config";
import { DENIAL, PRODUCT_ID_BUSINESS, STATUS } from "../src/constants";
import { UNLIMITED_SEATS, licenceIndexKey } from "../src/licence";
import { handleProvisionLicence, revokeLicence } from "../src/licence-provision";
import { findKeyByVirtualKey, revokeKey } from "../src/store";
import { buildClaims, buildLicenceToken, generateLicenceKeyPair } from "../tools/issue-licence.mjs";
import { fakeKv } from "./fake-kv";

/**
 * `POST /api/provision-licence`, exercised through the real handler and a real KV fake.
 *
 * Licences here are minted by the operator's actual tool and verified by the Worker's actual
 * verifier, so these tests cover the whole B2B path rather than a mock of it. What they cannot
 * cover is the device end — that the app pastes the key and the proxy honours it — which needs a
 * real install.
 */

const pair = generateLicenceKeyPair();
const PACKAGE = "app.gestu.assistant";
const NOW = Date.UTC(2026, 5, 1);
const YEAR = Date.UTC(2027, 5, 1);

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    PRO_KV: fakeKv(),
    GESTU_ALLOWED_PACKAGE_NAMES: PACKAGE,
    GESTU_LICENCE_PUBLIC_KEY: pair.publicKey,
    ...overrides,
  } as unknown as Env;
}

interface Reply {
  ok: boolean;
  virtualKey: string;
  reason: string;
  expiresAt: number;
}

/** Posts a licence to the handler and decodes the answer. */
async function post(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Reply }> {
  const request = new Request("https://pro.gestu.ca/api/provision-licence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleProvisionLicence(request, env, readConfig(env), NOW);
  return { status: response.status, body: (await response.json()) as Reply };
}

/** A signed licence, valid for a year from `NOW` unless overridden. */
function licence(overrides: { id?: string; expiresAt?: number; seats?: number } = {}): string {
  return buildLicenceToken(
    buildClaims({
      licenceId: overrides.id ?? "acme-2026",
      organisation: "Acme Corp",
      issuedAt: NOW,
      expiresAt: overrides.expiresAt ?? YEAR,
      seats: overrides.seats ?? 0,
      invoiceRef: "INV-1042",
    }),
    pair.privateKey,
  );
}

function redeem(env: Env, token: string, deviceId = "device-a") {
  return post(env, { licence: token, packageName: PACKAGE, deviceId, appVersion: "1.6.0" });
}

describe("licence provisioning", () => {
  it("mints a working key for a real licence", async () => {
    const env = makeEnv();
    const { status, body } = await redeem(env, licence());

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.virtualKey.startsWith("gsk_")).toBe(true);
    expect(body.expiresAt).toBe(YEAR);

    // The property that matters: the minted key resolves through the same lookup the proxy uses,
    // and is recorded as a business licence rather than as a subscription.
    const record = await findKeyByVirtualKey(env.PRO_KV, body.virtualKey);
    expect(record).not.toBeNull();
    expect(record?.status).toBe(STATUS.ACTIVE);
    expect(record?.productId).toBe(PRODUCT_ID_BUSINESS);
    expect(record?.expiresAt).toBe(YEAR);
  });

  it("gives a reinstalling device the same subscription, on a fresh secret", async () => {
    const env = makeEnv();
    const token = licence();
    const first = await redeem(env, token);
    const second = await redeem(env, token);

    expect(second.body.ok).toBe(true);
    // A new secret, because the old one was never shown to the server again and leaving it live
    // would let a copied credential keep working indefinitely.
    expect(second.body.virtualKey).not.toBe(first.body.virtualKey);
    expect(await findKeyByVirtualKey(env.PRO_KV, first.body.virtualKey)).toBeNull();
    expect(await findKeyByVirtualKey(env.PRO_KV, second.body.virtualKey)).not.toBeNull();
  });

  it("holds a licence to its seat count", async () => {
    const env = makeEnv();
    const token = licence({ seats: 1 });

    expect((await redeem(env, token, "device-a")).body.ok).toBe(true);
    const secondDevice = await redeem(env, token, "device-b");

    expect(secondDevice.body.ok).toBe(false);
    expect(secondDevice.body.reason).toBe(DENIAL.DEVICE_LIMIT);
  });

  it("falls back to the deployment's device limit when the licence states no seats", async () => {
    const env = makeEnv({ GESTU_DEVICE_LIMIT: "1" });
    const token = licence({ seats: 0 });

    expect((await redeem(env, token, "device-a")).body.ok).toBe(true);
    expect((await redeem(env, token, "device-b")).body.reason).toBe(DENIAL.DEVICE_LIMIT);
  });

  // The promise the business tier is sold on: every device on a licence works at once, rather than
  // only the one that provisioned most recently.
  it("leaves every device on an unlimited licence working at once", async () => {
    const env = makeEnv({ GESTU_DEVICE_LIMIT: "1" });
    const token = licence({ seats: UNLIMITED_SEATS });

    const keys: string[] = [];
    for (const deviceId of ["device-a", "device-b", "device-c"]) {
      const granted = await redeem(env, token, deviceId);
      expect(granted.body.ok, `${deviceId} should be allowed on an unlimited licence`).toBe(true);
      keys.push(granted.body.virtualKey);
    }

    // The whole point of "unlimited users" is that they all keep working — not that the newest one
    // does. Every key handed out above must still resolve.
    for (const key of keys) {
      expect(await findKeyByVirtualKey(env.PRO_KV, key), `${key} should still resolve`).not.toBeNull();
    }
  });

  it("keeps a revoked licence revoked", async () => {
    const env = makeEnv();
    const token = licence();
    const granted = await redeem(env, token);

    const keyId = await sha256Hex(granted.body.virtualKey);
    await revokeKey(env.PRO_KV, keyId, STATUS.REVOKED, NOW);

    // Re-provisioning must not hand out a replacement: otherwise revoking a leaked credential
    // would achieve nothing at all.
    const again = await redeem(env, token);
    expect(again.body.ok).toBe(false);
    expect(again.body.reason).toBe(DENIAL.REVOKED);
  });
});

describe("licence refusals never mint", () => {
  it("refuses a licence signed by another key", async () => {
    const env = makeEnv();
    const forged = buildLicenceToken(
      buildClaims({
        licenceId: "forged",
        organisation: "Not Acme",
        issuedAt: NOW,
        expiresAt: YEAR,
        seats: 0,
        invoiceRef: "",
      }),
      generateLicenceKeyPair().privateKey,
    );

    const { status, body } = await redeem(env, forged);
    expect(status).toBe(200);
    expect(body.reason).toBe(DENIAL.INVALID_TOKEN);
    expect(body.virtualKey).toBe("");
    // Nothing may be left behind by a refusal.
    expect((env.PRO_KV as unknown as { dump(): Map<string, string> }).dump().size).toBe(0);
  });

  it("refuses an expired licence with `expired`, not `invalid_token`", async () => {
    const env = makeEnv();
    const token = licence({ expiresAt: NOW - 86_400_000 });
    const { body } = await redeem(env, token);
    expect(body.ok).toBe(false);
    expect(body.reason).toBe(DENIAL.EXPIRED);
  });

  it("refuses an app that is not on the allow list", async () => {
    const env = makeEnv();
    const { body } = await post(env, {
      licence: licence(),
      packageName: "com.example.other",
      deviceId: "device-a",
    });
    expect(body.ok).toBe(false);
    expect(body.reason).toBe(DENIAL.NOT_VERIFIED);
  });

  it("fails closed when no public key is configured", async () => {
    const env = makeEnv({ GESTU_LICENCE_PUBLIC_KEY: undefined });
    const { body } = await redeem(env, licence());
    expect(body.ok).toBe(false);
    // Not `invalid_token`: the licence is fine and the deployment is not.
    expect(body.reason).toBe(DENIAL.NOT_VERIFIED);
  });

  it("requires a device id", async () => {
    const env = makeEnv();
    await expect(
      post(env, { licence: licence(), packageName: PACKAGE, deviceId: "" }),
    ).rejects.toThrow();
  });

  it("refuses a body that is not a JSON object", async () => {
    const env = makeEnv();
    const request = new Request("https://pro.gestu.ca/api/provision-licence", {
      method: "POST",
      body: JSON.stringify([1, 2, 3]),
    });
    await expect(handleProvisionLicence(request, env, readConfig(env), NOW)).rejects.toThrow();
  });
});

describe("licence-wide revocation", () => {
  it("retires every device's key and refuses the licence afterwards", async () => {
    const env = makeEnv();
    const token = licence({ seats: UNLIMITED_SEATS });
    const a = await redeem(env, token, "device-a");
    const b = await redeem(env, token, "device-b");
    expect(a.body.ok, "device-a should provision").toBe(true);
    expect(b.body.ok, "device-b should provision").toBe(true);

    const retired = await revokeLicence(env, "acme-2026", NOW);
    expect(retired).toBe(2);

    // Every credential the licence issued is dead...
    expect(await findKeyByVirtualKey(env.PRO_KV, a.body.virtualKey)).toBeNull();
    expect(await findKeyByVirtualKey(env.PRO_KV, b.body.virtualKey)).toBeNull();
    // ...and the licence cannot be redeemed again, including from a device that never held a key.
    // A sweep alone would have left that door open, and a tombstone alone would have left the
    // devices above working until their credentials were rotated.
    const fresh = await redeem(env, token, "device-c");
    expect(fresh.body.ok).toBe(false);
    expect(fresh.body.reason).toBe(DENIAL.REVOKED);
  });
});

describe("licence index", () => {
  it("indexes a licence's key by device, not by licence", async () => {
    const env = makeEnv();
    const granted = await redeem(env, licence({ id: "acme-2026" }), "device-a");

    const dump = (env.PRO_KV as unknown as { dump(): Map<string, string> }).dump();
    // Per device, so a second device cannot take over the first one's entry — which is exactly what
    // the shared-key model did, and what left only the newest device able to authenticate.
    expect(dump.get(licenceIndexKey("acme-2026", "device-a"))).toBe(
      await sha256Hex(granted.body.virtualKey),
    );
    expect(dump.has(licenceIndexKey("acme-2026", "device-b"))).toBe(false);
  });
});

describe("pagination and key resolution", () => {
  it("paginates through multiple pages in countLicenceDevices and revokeLicence", async () => {
    const env = makeEnv();
    // Populate multiple device keys directly in KV
    const totalDevices = 5;
    for (let i = 0; i < totalDevices; i++) {
      const devKey = licenceIndexKey("acme-multi", `dev-${i}`);
      const vKey = `msk_test_${i}`;
      const kId = `keyid_${i}`;
      await env.PRO_KV.put(devKey, kId);
      await env.PRO_KV.put(`key:${kId}`, JSON.stringify({ status: STATUS.ACTIVE, virtualKey: vKey }));
    }

    // Wrap list to simulate paging with limit of 2 items per page
    const originalList = env.PRO_KV.list.bind(env.PRO_KV);
    let listCalls = 0;
    env.PRO_KV.list = async (options?: { prefix?: string; cursor?: string; limit?: number }) => {
      listCalls++;
      return originalList({ ...options, limit: 2 });
    };

    const { countLicenceDevices } = await import("../src/licence-provision");
    const count = await countLicenceDevices(env, "acme-multi");
    expect(count).toBe(totalDevices);
    expect(listCalls).toBeGreaterThan(1);

    // Now test revokeLicence with pagination
    listCalls = 0;
    const revoked = await revokeLicence(env, "acme-multi", NOW);
    expect(revoked).toBe(totalDevices);
    expect(listCalls).toBeGreaterThan(1);
  });

  it("resolves kid from KV when not in env", async () => {
    const customPair = generateLicenceKeyPair();
    const env = makeEnv({ GESTU_LICENCE_PUBLIC_KEY: undefined });
    await env.PRO_KV.put("licence-key:dynamic-kid", customPair.publicKey);

    const token = buildLicenceToken(
      buildClaims({
        licenceId: "kv-kid-licence",
        organisation: "KV Org",
        issuedAt: NOW,
        expiresAt: YEAR,
        seats: 5,
        invoiceRef: "INV-KV",
        kid: "dynamic-kid",
      }),
      customPair.privateKey,
    );

    const { status, body } = await redeem(env, token, "device-kv");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.virtualKey.startsWith("gsk_")).toBe(true);
  });

  it("links Free -> Pro to one deviceId, retires Free key, and consumes 0 new seats on reinstall", async () => {
    const { handleProvisionFreeToken, freeDeviceIndexKey, freeMeterIdForDevice } = await import("../src/free");
    const { countLicenceDevices } = await import("../src/licence-provision");
    const env = makeEnv();
    const deviceId = "0123456789abcdef0123456789abcdef";

    // 1. Device first provisions a Free credential.
    const freeReq = new Request("https://pro.gestu.ca/api/provision-free-token", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
      body: JSON.stringify({ deviceId, packageName: PACKAGE, appVersion: "2.6.6" }),
    });
    const freeRes = await handleProvisionFreeToken(freeReq, env, readConfig(env), NOW);
    const freeBody = (await freeRes.json()) as { ok: boolean; virtualKey: string };
    expect(freeBody.ok).toBe(true);
    expect(await findKeyByVirtualKey(env.PRO_KV, freeBody.virtualKey)).not.toBeNull();

    // 2. Same device upgrades to a 1-seat Pro licence -> Free key is retired, 1 seat consumed.
    const token = licence({ id: "upgrade-lic-1", seats: 1 });
    const pro1 = await redeem(env, token, deviceId);
    expect(pro1.body.ok).toBe(true);
    expect(await findKeyByVirtualKey(env.PRO_KV, freeBody.virtualKey)).toBeNull();
    expect(await env.PRO_KV.get(freeDeviceIndexKey(await sha256Hex(deviceId)))).toBeNull();
    expect(await countLicenceDevices(env, "upgrade-lic-1")).toBe(1);
    const proRecord = await findKeyByVirtualKey(env.PRO_KV, pro1.body.virtualKey);
    expect(proRecord?.upgradedFromFreeMeterId).toBe(await freeMeterIdForDevice(deviceId));

    // 3. Reinstall with the SAME persistent deviceId -> rotates secret and consumes 0 new seats.
    const pro2 = await redeem(env, token, deviceId);
    expect(pro2.body.ok).toBe(true);
    expect(pro2.body.virtualKey).not.toBe(pro1.body.virtualKey);
    expect(await findKeyByVirtualKey(env.PRO_KV, pro1.body.virtualKey)).toBeNull();
    expect(await countLicenceDevices(env, "upgrade-lic-1")).toBe(1);

    // 4. A genuinely NEW deviceId tries to join the 1-seat licence -> denied with device_limit.
    const newcomer = await redeem(env, token, "fedcba9876543210fedcba9876543210");
    expect(newcomer.body.ok).toBe(false);
    expect(newcomer.body.reason).toBe(DENIAL.DEVICE_LIMIT);
  });
});

