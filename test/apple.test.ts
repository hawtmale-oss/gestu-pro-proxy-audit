import { describe, expect, it } from "vitest";
import {
  decodeJwsPayload,
  grantFromAppleTransaction,
  handleAppleAsn,
  verifyAppleTransaction,
} from "../src/apple";
import type { AppleNotificationPayload, AppleTransactionPayload } from "../src/apple";
import { base64UrlEncode, utf8 } from "../src/base64";
import type { Env, ProxyConfig } from "../src/config";
import { DENIAL, STATUS } from "../src/constants";
import { newKeyRecord, purchaseTokenHash, putKeyRecord, putPurchaseRecord } from "../src/store";

function makeFakeJws(payload: object): string {
  const header = base64UrlEncode(utf8(JSON.stringify({ alg: "ES256" })));
  const payloadStr = base64UrlEncode(utf8(JSON.stringify(payload)));
  const sig = base64UrlEncode(utf8("fake_sig"));
  return `${header}.${payloadStr}.${sig}`;
}

const defaultConfig: ProxyConfig = {
  productId: "gestu_pro_monthly",
  basePlanId: "gestu-pro-monthly",
  monthlyTokenLimit: 101_500_000,
  freeMonthlyOutputTokenLimit: 200_000,
  businessMonthlyTokenLimit: 1_015_000_000,
  allowedPackageNames: ["ca.gestu.app"],
  proUpstreamBaseUrl: "https://api.deepseek.com",
  proUpstreamModelId: "deepseek-flash",
  freeUpstreamBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  freeUpstreamModelId: "gemini-3.5-flash-lite",
  exposedModels: [],
  deviceLimit: 3,
  publicBaseUrl: "https://api.gestu.ca",
  proxyBaseUrl: "https://api.gestu.ca/v1",
  allowedOrigins: [],
  googleOAuthTokenUrl: "https://oauth2.googleapis.com/token",
  googlePlayApiBase: "https://androidpublisher.googleapis.com",
  rtdnAudience: "gestu-rtdn",
};

function createMemoryKv(): KVNamespace {
  const map = new Map<string, string>();
  return {
    async get(key: string): Promise<string | null> {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  } as unknown as KVNamespace;
}

describe("Apple StoreKit 2 verification", () => {
  const now = 1700000000000;

  it("decodes a valid JWS payload", () => {
    const payload = { testKey: "testValue", number: 42 };
    const jws = makeFakeJws(payload);
    const decoded = decodeJwsPayload<typeof payload>(jws);
    expect(decoded).toEqual(payload);
  });

  it("rejects an invalid JWS format", () => {
    expect(() => decodeJwsPayload("invalid_jws")).toThrow("Invalid JWS");
  });

  it("maps an active transaction to ACTIVE grant", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_123",
      originalTransactionId: "orig_tx_123",
      bundleId: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now - 10000,
      originalPurchaseDate: now - 10000,
      expiresDate: now + 86400000,
    };
    const grant = grantFromAppleTransaction(transaction, now);
    expect(grant.status).toBe(STATUS.ACTIVE);
    expect(grant.entitled).toBe(true);
    expect(grant.isRevoked).toBe(false);
  });

  it("maps an expired transaction to EXPIRED grant", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_123",
      originalTransactionId: "orig_tx_123",
      bundleId: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now - 200000,
      originalPurchaseDate: now - 200000,
      expiresDate: now - 5000,
    };
    const grant = grantFromAppleTransaction(transaction, now);
    expect(grant.status).toBe(STATUS.EXPIRED);
    expect(grant.entitled).toBe(false);
  });

  it("maps a revoked transaction to REVOKED grant", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_123",
      originalTransactionId: "orig_tx_123",
      bundleId: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now - 200000,
      originalPurchaseDate: now - 200000,
      expiresDate: now + 86400000,
      revocationDate: now - 1000,
    };
    const grant = grantFromAppleTransaction(transaction, now);
    expect(grant.status).toBe(STATUS.REVOKED);
    expect(grant.entitled).toBe(false);
    expect(grant.isRevoked).toBe(true);
  });

  it("successfully verifies a valid active Apple transaction", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_valid",
      originalTransactionId: "orig_valid",
      bundleId: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now - 1000,
      originalPurchaseDate: now - 1000,
      expiresDate: now + 30 * 86400000,
    };
    const jws = makeFakeJws(transaction);
    const result = verifyAppleTransaction(jws, "ca.gestu.app", "gestu_pro_monthly", now);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant.status).toBe(STATUS.ACTIVE);
      expect(result.grant.entitled).toBe(true);
    }
  });

  it("fails verification if bundleId does not match", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_wrong_bundle",
      originalTransactionId: "orig_wrong_bundle",
      bundleId: "com.other.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now - 1000,
      originalPurchaseDate: now - 1000,
      expiresDate: now + 30 * 86400000,
    };
    const jws = makeFakeJws(transaction);
    const result = verifyAppleTransaction(jws, "ca.gestu.app", "gestu_pro_monthly", now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(DENIAL.INVALID_TOKEN);
      expect(result.message).toContain("Bundle ID mismatch");
    }
  });

  it("fails verification if productId does not match", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_wrong_prod",
      originalTransactionId: "orig_wrong_prod",
      bundleId: "ca.gestu.app",
      productId: "other_tier",
      purchaseDate: now - 1000,
      originalPurchaseDate: now - 1000,
      expiresDate: now + 30 * 86400000,
    };
    const jws = makeFakeJws(transaction);
    const result = verifyAppleTransaction(jws, "ca.gestu.app", "gestu_pro_monthly", now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(DENIAL.INVALID_TOKEN);
      expect(result.message).toContain("Product ID mismatch");
    }
  });

  it("fails verification if subscription has expired", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_expired",
      originalTransactionId: "orig_expired",
      bundleId: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now - 40 * 86400000,
      originalPurchaseDate: now - 40 * 86400000,
      expiresDate: now - 10 * 86400000,
    };
    const jws = makeFakeJws(transaction);
    const result = verifyAppleTransaction(jws, "ca.gestu.app", "gestu_pro_monthly", now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(DENIAL.EXPIRED);
    }
  });

  it("fails verification if subscription was revoked", () => {
    const transaction: AppleTransactionPayload = {
      transactionId: "tx_revoked",
      originalTransactionId: "orig_revoked",
      bundleId: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now - 1000,
      originalPurchaseDate: now - 1000,
      expiresDate: now + 30 * 86400000,
      revocationDate: now - 500,
    };
    const jws = makeFakeJws(transaction);
    const result = verifyAppleTransaction(jws, "ca.gestu.app", "gestu_pro_monthly", now);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(DENIAL.REVOKED);
    }
  });
});

describe("Apple App Store Server Notifications V2 (ASN2)", () => {
  const now = 1700000000000;

  it("rejects non-POST method with 405", async () => {
    const env: Env = { PRO_KV: createMemoryKv() };
    const req = new Request("https://pro.gestu.ca/api/apple-asn", { method: "GET" });
    const res = await handleAppleAsn(req, env, defaultConfig, now);
    expect(res.status).toBe(405);
  });

  it("rejects missing signedPayload with 400", async () => {
    const env: Env = { PRO_KV: createMemoryKv() };
    const req = new Request("https://pro.gestu.ca/api/apple-asn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await expect(handleAppleAsn(req, env, defaultConfig, now)).rejects.toThrow("signedPayload is required");
  });

  it("processes DID_RENEW and updates KV key record", async () => {
    const kv = createMemoryKv();
    const env: Env = { PRO_KV: kv };

    const originalTx = "orig_apple_sub_1";
    const tokenHash = await purchaseTokenHash(originalTx);
    const keyId = "apple_user_1";
    const record = newKeyRecord({
      keyId,
      packageName: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "",
      expiresAt: now - 1000,
      status: STATUS.EXPIRED,
      playState: "EXPIRED",
      latestOrderId: "order_123",
      deviceId: "dev_apple_1",
      deviceLimit: 3,
      now,
    });
    record.status = STATUS.EXPIRED;
    await putKeyRecord(kv, record);
    await putPurchaseRecord(kv, {
      tokenHash,
      keyId,
      packageName: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "",
      status: STATUS.EXPIRED,
      expiresAt: now - 1000,
      updatedAt: now,
      linkedTokenHash: "",
    });

    const txPayload: AppleTransactionPayload = {
      transactionId: "tx_renew_2",
      originalTransactionId: originalTx,
      bundleId: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      purchaseDate: now,
      originalPurchaseDate: now - 30 * 86400000,
      expiresDate: now + 30 * 86400000,
    };
    const signedTx = makeFakeJws(txPayload);

    const notificationPayload: AppleNotificationPayload = {
      notificationType: "DID_RENEW",
      subtype: "BILLING_RECOVERY",
      notificationUUID: "uuid-1234",
      data: {
        bundleId: "ca.gestu.app",
        environment: "Production",
        signedTransactionInfo: signedTx,
      },
      version: "2.0",
      signedDate: now,
    };
    const signedNotification = makeFakeJws(notificationPayload);

    const req = new Request("https://pro.gestu.ca/api/apple-asn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedPayload: signedNotification }),
    });

    const res = await handleAppleAsn(req, env, defaultConfig, now);
    expect(res.status).toBe(200);

    const raw = await kv.get(`key:${keyId}`);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.status).toBe(STATUS.ACTIVE);
    expect(parsed.expiresAt).toBe(now + 30 * 86400000);
  });

  it("ignores notifications for unrecognised bundleId safely", async () => {
    const kv = createMemoryKv();
    const env: Env = { PRO_KV: kv };

    const notificationPayload: AppleNotificationPayload = {
      notificationType: "DID_RENEW",
      notificationUUID: "uuid-foreign",
      data: {
        bundleId: "com.other.app",
        environment: "Production",
        signedTransactionInfo: makeFakeJws({
          transactionId: "tx_foreign",
          originalTransactionId: "orig_foreign",
          bundleId: "com.other.app",
          productId: "gestu_pro_monthly",
          purchaseDate: now,
          originalPurchaseDate: now,
        }),
      },
      version: "2.0",
      signedDate: now,
    };
    const signedNotification = makeFakeJws(notificationPayload);

    const req = new Request("https://pro.gestu.ca/api/apple-asn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedPayload: signedNotification }),
    });

    const res = await handleAppleAsn(req, env, defaultConfig, now);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; handled?: string };
    expect(body.ok).toBe(true);
    expect(body.handled).toBe("ignored_bundle");
  });
});

