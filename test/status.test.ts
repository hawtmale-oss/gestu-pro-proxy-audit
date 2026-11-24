import { describe, expect, it } from "vitest";
import { mintVirtualKey, sha256Hex } from "../src/base64";
import { handleSubscriptionStatus } from "../src/api";
import type { Env } from "../src/config";
import { readConfig } from "../src/config";
import { FREE_MONTHLY_OUTPUT_TOKENS, PRODUCT_ID_FREE, PRODUCT_ID_PRO, STATUS } from "../src/constants";
import { freeMeterIdForDevice } from "../src/free";
import { recordTierUsage } from "../src/quota";
import { newKeyRecord, putKeyRecord, revokeKey } from "../src/store";
import { fakeKv } from "./fake-kv";

/**
 * `/api/subscription-status` regression tests.
 *
 * Two defects are pinned here: a Free managed key used to be reported as `pro` (the endpoint
 * treated "has an entitlement" as "is Pro"), and a canceled-but-paid Pro subscription reported as
 * unentitled. Both are plan/status *mapping* bugs, so the assertions are on the answer's vocabulary.
 */
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const FUTURE = NOW + 30 * 86_400_000;

function makeEnv(): Env {
  return {
    PRO_KV: fakeKv(),
    GESTU_ALLOWED_PACKAGE_NAMES: "com.gestu.app",
    UPSTREAM_API_KEY: "test-upstream",
  };
}

async function seedRecord(
  env: Env,
  input: { productId: string; status: string; expiresAt: number },
): Promise<{ vKey: string; keyId: string; meterId: string }> {
  const vKey = mintVirtualKey();
  const keyId = await sha256Hex(vKey);
  const meterId = input.productId === PRODUCT_ID_FREE ? await freeMeterIdForDevice(`dev-${keyId}`) : keyId;
  await putKeyRecord(env.PRO_KV, {
    ...newKeyRecord({
      keyId,
      packageName: "com.gestu.app",
      productId: input.productId,
      obfuscatedAccountId: "",
      expiresAt: input.expiresAt,
      status: input.status as never,
      playState: "",
      latestOrderId: "",
      deviceId: "dev-1",
      deviceLimit: 2,
      now: NOW,
    }),
    meterId,
  });
  return { vKey, keyId, meterId };
}

function statusRequest(vKey: string): Request {
  return new Request("https://api.gestu.ca/api/subscription-status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ virtualKey: vKey, deviceId: "dev-1" }),
  });
}

interface StatusBody {
  ok: boolean;
  plan: string;
  status: string;
  usedTokens: number;
  limitTokens: number;
}

describe("POST /api/subscription-status plan mapping", () => {
  it("reports a live Free key as the Free plan with the KV fallback allowance", async () => {
    const env = makeEnv();
    const { vKey, meterId } = await seedRecord(env, {
      productId: PRODUCT_ID_FREE,
      status: STATUS.ACTIVE,
      expiresAt: 0,
    });
    await recordTierUsage(env.PRO_KV, meterId, 500, 1_234, NOW);

    const res = await handleSubscriptionStatus(statusRequest(vKey), env, readConfig(env), NOW);
    const body = (await res.json()) as StatusBody;
    expect(body.ok).toBe(true);
    expect(body.plan).toBe("free");
    expect(body.status).toBe("active");
    expect(body.limitTokens).toBe(FREE_MONTHLY_OUTPUT_TOKENS);
    // The Free meter is the device's output count, read from its stable meter id.
    expect(body.usedTokens).toBe(1_234);
  });

  it("reports a live Pro key as Pro with the 1,500,000-output allowance", async () => {
    const env = makeEnv();
    const { vKey, keyId } = await seedRecord(env, {
      productId: PRODUCT_ID_PRO,
      status: STATUS.ACTIVE,
      expiresAt: FUTURE,
    });
    await recordTierUsage(env.PRO_KV, keyId, 2_000, 3_456, NOW);

    const res = await handleSubscriptionStatus(statusRequest(vKey), env, readConfig(env), NOW);
    const body = (await res.json()) as StatusBody;
    expect(body.ok).toBe(true);
    expect(body.plan).toBe("pro");
    expect(body.status).toBe("active");
    expect(body.usedTokens).toBe(3_456);
  });

  it("keeps a canceled-but-paid Pro subscription entitled and reported as Pro with status canceled", async () => {
    const env = makeEnv();
    const { vKey } = await seedRecord(env, {
      productId: PRODUCT_ID_PRO,
      status: STATUS.CANCELED,
      expiresAt: FUTURE,
    });

    const res = await handleSubscriptionStatus(statusRequest(vKey), env, readConfig(env), NOW);
    const body = (await res.json()) as StatusBody;
    expect(body.ok).toBe(true);
    expect(body.plan).toBe("pro");
    expect(body.status).toBe("canceled");
  });

  it("still explains a revoked Pro key (tombstone) as Pro/revoked", async () => {
    const env = makeEnv();
    const { vKey, keyId } = await seedRecord(env, {
      productId: PRODUCT_ID_PRO,
      status: STATUS.ACTIVE,
      expiresAt: FUTURE,
    });
    await revokeKey(env.PRO_KV, keyId, STATUS.REVOKED, NOW);

    const res = await handleSubscriptionStatus(statusRequest(vKey), env, readConfig(env), NOW);
    const body = (await res.json()) as StatusBody;
    expect(body.status).toBe("revoked");
    expect(body.plan).toBe("pro");
  });

  it("answers an unrecognised key as an unknown subscription without claiming a plan", async () => {
    const env = makeEnv();
    const res = await handleSubscriptionStatus(
      statusRequest(mintVirtualKey()),
      env,
      readConfig(env),
      NOW,
    );
    const body = (await res.json()) as StatusBody;
    expect(body.ok).toBe(false);
    expect(body.plan).toBe("free");
    expect(body.status).toBe("none");
  });
});
