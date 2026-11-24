import { describe, expect, it, vi } from "vitest";
import { handleRtdn } from "../src/api";
import { base64UrlEncode, utf8 } from "../src/base64";
import type { Env, ProxyConfig } from "../src/config";
import { STATUS } from "../src/constants";
import { importSigningKey, signRs256Jwt } from "../src/crypto";
import { resetGoogleJwksCacheForTests } from "../src/google";
import {
  basePlanIdFromLineItems,
  classifyRtdn,
  grantFromPurchase,
  hasLineItemForProduct,
  isEntitledNow,
  isKnownPlaySubscriptionState,
  latestExpiryFromLineItems,
  mapPlaySubscriptionState,
  parsePlayTimestamp,
  RTDN_TYPE,
  rtdnTypeName,
  terminalStateFromNotification,
} from "../src/play";
import type { PlaySubscriptionPurchaseV2 } from "../src/play";
import { newKeyRecord, purchaseTokenHash, putKeyRecord, putPurchaseRecord } from "../src/store";
import { fakeKv } from "./fake-kv";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const FUTURE = "2026-10-15T12:00:00Z";
const PAST = "2026-08-15T12:00:00Z";

/**
 * Every member of Play's `SubscriptionState` enum, from the Android Publisher v3 Discovery
 * document (`https://androidpublisher.googleapis.com/$discovery/rest?version=v3`,
 * `schemas.SubscriptionPurchaseV2.properties.subscriptionState.enum`).
 */
const ALL_PLAY_STATES = [
  "SUBSCRIPTION_STATE_UNSPECIFIED",
  "SUBSCRIPTION_STATE_PENDING",
  "SUBSCRIPTION_STATE_ACTIVE",
  "SUBSCRIPTION_STATE_PAUSED",
  "SUBSCRIPTION_STATE_IN_GRACE_PERIOD",
  "SUBSCRIPTION_STATE_ON_HOLD",
  "SUBSCRIPTION_STATE_CANCELED",
  "SUBSCRIPTION_STATE_EXPIRED",
  "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED",
] as const;

describe("mapPlaySubscriptionState", () => {
  it("maps all nine documented states to the app's vocabulary", () => {
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_ACTIVE")).toBe(STATUS.ACTIVE);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_IN_GRACE_PERIOD")).toBe(STATUS.GRACE);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_ON_HOLD")).toBe(STATUS.ON_HOLD);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_CANCELED")).toBe(STATUS.CANCELED);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_EXPIRED")).toBe(STATUS.EXPIRED);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_PAUSED")).toBe(STATUS.EXPIRED);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_PENDING")).toBe(STATUS.CANCELED);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED")).toBe(STATUS.NONE);
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_UNSPECIFIED")).toBe(STATUS.NONE);
  });

  it("does not collapse an unknown state into active", () => {
    // Google adds enum members over time; a state this build has never heard of is not access.
    expect(mapPlaySubscriptionState("SUBSCRIPTION_STATE_SOMETHING_NEW")).toBe(STATUS.NONE);
    expect(mapPlaySubscriptionState("")).toBe(STATUS.NONE);
    expect(isKnownPlaySubscriptionState("SUBSCRIPTION_STATE_SOMETHING_NEW")).toBe(false);
  });

  it("recognises exactly the nine documented states", () => {
    for (const state of ALL_PLAY_STATES) expect(isKnownPlaySubscriptionState(state)).toBe(true);
    expect(isKnownPlaySubscriptionState("SUBSCRIPTION_STATE_SOMETHING_NEW")).toBe(false);
    // The only two states that map to a live entitlement are the two that mean it. Everything
    // else — including PAUSED and CANCELED — must be refused by the entitlement check.
    const entitling = ALL_PLAY_STATES.filter((state) =>
      [STATUS.ACTIVE, STATUS.GRACE].includes(mapPlaySubscriptionState(state) as typeof STATUS.ACTIVE),
    );
    expect(entitling).toEqual(["SUBSCRIPTION_STATE_ACTIVE", "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"]);
  });
});

describe("parsePlayTimestamp", () => {
  it("parses RFC 3339 and refuses to produce NaN", () => {
    expect(parsePlayTimestamp("2026-10-15T12:00:00Z")).toBe(Date.UTC(2026, 9, 15, 12));
    expect(parsePlayTimestamp("2026-10-15T12:00:00.000Z")).toBe(Date.UTC(2026, 9, 15, 12));
    expect(parsePlayTimestamp("")).toBe(0);
    expect(parsePlayTimestamp("not a date")).toBe(0);
    expect(parsePlayTimestamp(undefined)).toBe(0);
    expect(parsePlayTimestamp(12345)).toBe(0);
  });
});

describe("latestExpiryFromLineItems", () => {
  it("takes the furthest-out expiry so an add-on does not shorten the paid period", () => {
    expect(
      latestExpiryFromLineItems([
        { productId: "gestu_pro_monthly", expiryTime: FUTURE },
        { productId: "gestu_pro_monthly_addon", expiryTime: "2026-12-15T12:00:00Z" },
      ]),
    ).toBe(Date.parse("2026-12-15T12:00:00Z"));
  });

  it("returns 0 rather than NaN when there is nothing to read", () => {
    expect(latestExpiryFromLineItems(undefined)).toBe(0);
    expect(latestExpiryFromLineItems([])).toBe(0);
    expect(latestExpiryFromLineItems([{}])).toBe(0);
  });
});

describe("basePlanIdFromLineItems", () => {
  it("reads the base plan of the purchased product only", () => {
    const items = [
      { productId: "other", offerDetails: { basePlanId: "wrong" } },
      { productId: "gestu_pro_monthly", offerDetails: { basePlanId: "gestu-pro-monthly" } },
    ];
    expect(basePlanIdFromLineItems(items, "gestu_pro_monthly")).toBe("gestu-pro-monthly");
    expect(basePlanIdFromLineItems(items, "missing")).toBe("");
  });
});

describe("hasLineItemForProduct", () => {
  it("is a real membership test", () => {
    expect(hasLineItemForProduct([{ productId: "gestu_pro_monthly" }], "gestu_pro_monthly")).toBe(true);
    expect(hasLineItemForProduct([{ productId: "other" }], "gestu_pro_monthly")).toBe(false);
    expect(hasLineItemForProduct(undefined, "gestu_pro_monthly")).toBe(false);
  });
});

describe("grantFromPurchase", () => {
  const purchase = (overrides: Partial<PlaySubscriptionPurchaseV2>): PlaySubscriptionPurchaseV2 => ({
    subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
    acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    lineItems: [
      {
        productId: "gestu_pro_monthly",
        expiryTime: FUTURE,
        offerDetails: { basePlanId: "gestu-pro-monthly" },
        autoRenewingPlan: { autoRenewEnabled: true },
      },
    ],
    ...overrides,
  });

  it("builds a live grant from an active purchase", () => {
    const grant = grantFromPurchase(purchase({}), NOW);
    expect(grant.status).toBe(STATUS.ACTIVE);
    expect(grant.entitled).toBe(true);
    expect(grant.productId).toBe("gestu_pro_monthly");
    expect(grant.basePlanId).toBe("gestu-pro-monthly");
    expect(grant.autoRenewing).toBe(true);
    expect(grant.expiresAt).toBe(Date.parse(FUTURE));
    expect(grant.isTestPurchase).toBe(false);
  });

  it("keeps access for a canceled subscription that is still inside its paid period", () => {
    const grant = grantFromPurchase(
      purchase({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", lineItems: [
        { productId: "gestu_pro_monthly", expiryTime: FUTURE, autoRenewingPlan: { autoRenewEnabled: false } },
      ] }),
      NOW,
    );
    expect(grant.status).toBe(STATUS.CANCELED);
    expect(grant.entitled).toBe(true);
    expect(grant.autoRenewing).toBe(false);
  });

  it("refuses a canceled subscription whose period has ended", () => {
    const grant = grantFromPurchase(
      purchase({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", lineItems: [
        { productId: "gestu_pro_monthly", expiryTime: PAST },
      ] }),
      NOW,
    );
    expect(grant.entitled).toBe(false);
  });

  it("refuses on-hold and expired grants", () => {
    for (const state of ["SUBSCRIPTION_STATE_ON_HOLD", "SUBSCRIPTION_STATE_EXPIRED", "SUBSCRIPTION_STATE_PAUSED"]) {
      const grant = grantFromPurchase(purchase({ subscriptionState: state }), NOW);
      expect(grant.entitled, state).toBe(false);
    }
  });

  it("carries the account identifiers and the linked purchase token", () => {
    const grant = grantFromPurchase(
      purchase({
        linkedPurchaseToken: "old-token",
        regionCode: "GB",
        externalAccountIdentifiers: { obfuscatedExternalAccountId: "obf-1" },
        testPurchase: {},
      }),
      NOW,
    );
    expect(grant.linkedPurchaseToken).toBe("old-token");
    expect(grant.regionCode).toBe("GB");
    expect(grant.obfuscatedExternalAccountId).toBe("obf-1");
    expect(grant.isTestPurchase).toBe(true);
  });

  it("falls back to externalAccountId when no obfuscated id is present", () => {
    const grant = grantFromPurchase(
      purchase({ externalAccountIdentifiers: { externalAccountId: "ext-1" } }),
      NOW,
    );
    expect(grant.obfuscatedExternalAccountId).toBe("ext-1");
  });

  it("survives a purchase body with no line items at all", () => {
    const grant = grantFromPurchase({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" }, NOW);
    expect(grant.expiresAt).toBe(0);
    expect(grant.productId).toBe("");
    // No expiry means "unknown", and an active state with unknown expiry is still access.
    expect(grant.entitled).toBe(true);
  });
});

describe("isEntitledNow", () => {
  it("is the single access predicate for the proxy gate", () => {
    expect(isEntitledNow(STATUS.ACTIVE, NOW + 1, NOW)).toBe(true);
    expect(isEntitledNow(STATUS.GRACE, NOW + 1, NOW)).toBe(true);
    expect(isEntitledNow(STATUS.CANCELED, NOW + 1, NOW)).toBe(true);
    expect(isEntitledNow(STATUS.CANCELED, NOW - 1, NOW)).toBe(false);
    expect(isEntitledNow(STATUS.ON_HOLD, NOW + 1, NOW)).toBe(false);
  });
});

describe("RTDN classification", () => {
  it("names every documented notification type", () => {
    expect(rtdnTypeName(RTDN_TYPE.SUBSCRIPTION_RECOVERED)).toBe("SUBSCRIPTION_RECOVERED");
    expect(rtdnTypeName(RTDN_TYPE.SUBSCRIPTION_EXPIRED)).toBe("SUBSCRIPTION_EXPIRED");
    expect(rtdnTypeName(RTDN_TYPE.SUBSCRIPTION_PENDING_PURCHASE_CANCELED)).toBe(
      "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
    );
    expect(rtdnTypeName(999)).toBe("UNKNOWN_999");
  });

  it("decodes a subscription notification exactly as Google documents it", () => {
    // Body from https://developer.android.com/google/play/billing/rtdn-reference#example
    const decoded = classifyRtdn({
      version: "1.0",
      packageName: "com.some.thing",
      eventTimeMillis: "1503349566168",
      subscriptionNotification: {
        version: "1.0",
        notificationType: 4,
        purchaseToken: "PURCHASE_TOKEN",
      },
    });
    expect(decoded.kind).toBe("subscription");
    expect(decoded.notificationType).toBe(4);
    expect(decoded.notificationName).toBe("SUBSCRIPTION_PURCHASED");
    expect(decoded.purchaseToken).toBe("PURCHASE_TOKEN");
    expect(decoded.packageName).toBe("com.some.thing");
    expect(decoded.eventTimeMillis).toBe(1503349566168);
  });

  it("recognises the notification kinds this backend does not act on", () => {
    expect(classifyRtdn({ testNotification: { version: "1.0" } }).kind).toBe("test");
    expect(
      classifyRtdn({ voidedPurchaseNotification: { purchaseToken: "t", orderId: "o", refundType: 1 } }).kind,
    ).toBe("voided");
    expect(classifyRtdn({ oneTimeProductNotification: { purchaseToken: "t", sku: "s" } }).kind).toBe(
      "one_time",
    );
    expect(classifyRtdn({ pendingRefundReviewNotification: { purchaseToken: "t" } }).kind).toBe(
      "pending_refund_review",
    );
    expect(classifyRtdn({}).kind).toBe("unknown");
  });

  it("treats only expired as terminal from the notification alone", () => {
    expect(terminalStateFromNotification(RTDN_TYPE.SUBSCRIPTION_EXPIRED)).toEqual({
      status: STATUS.EXPIRED,
      deleteKey: false,
    });
    for (const type of [
      RTDN_TYPE.SUBSCRIPTION_PURCHASED,
      RTDN_TYPE.SUBSCRIPTION_RENEWED,
      RTDN_TYPE.SUBSCRIPTION_RECOVERED,
      RTDN_TYPE.SUBSCRIPTION_CANCELED,
      RTDN_TYPE.SUBSCRIPTION_ON_HOLD,
      RTDN_TYPE.SUBSCRIPTION_IN_GRACE_PERIOD,
      RTDN_TYPE.SUBSCRIPTION_RESTARTED,
      RTDN_TYPE.SUBSCRIPTION_DEFERRED,
      RTDN_TYPE.SUBSCRIPTION_PAUSED,
      RTDN_TYPE.SUBSCRIPTION_REVOKED,
    ]) {
      expect(terminalStateFromNotification(type), String(type)).toBeNull();
    }
  });
});

describe("POST /api/rtdn handler", () => {
  const webcrypto = (globalThis as unknown as { crypto: Crypto }).crypto;

  async function makeRsaPemPair(): Promise<{ privateKeyPem: string; publicKeyPem: string; jwk: JsonWebKey }> {
    const { subtle } = webcrypto;
    const pair = (await subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;

    const toPem = (der: ArrayBuffer, label: string): string => {
      const base64 = base64UrlEncode(new Uint8Array(der)).replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const lines = padded.match(/.{1,64}/g) ?? [];
      return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
    };

    const pkcs8 = (await subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
    const spki = (await subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer;
    const jwk = (await subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
    return { privateKeyPem: toPem(pkcs8, "PRIVATE KEY"), publicKeyPem: toPem(spki, "PUBLIC KEY"), jwk };
  }

  function makeRtdnPushRequest(payload: object, token?: string): Request {
    const dataStr = base64UrlEncode(utf8(JSON.stringify(payload)));
    const envelope = {
      message: {
        data: dataStr,
        messageId: `msg-${Date.now()}-${Math.random()}`,
      },
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== undefined) {
      headers["authorization"] = `Bearer ${token}`;
    }
    return new Request("https://pro.gestu.ca/api/rtdn", {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
    });
  }

  it("fails closed with 503 server_misconfigured when RTDN_AUDIENCE is unset", async () => {
    const kv = fakeKv();
    const env = { PRO_KV: kv } as Env;
    const config: ProxyConfig = {
      productId: "gestu_pro_monthly",
      basePlanId: "gestu-pro-monthly",
      monthlyTokenLimit: 300_000_000,
      businessMonthlyTokenLimit: 1_000_000_000,
      allowedPackageNames: ["ca.gestu.app"],
      proUpstreamBaseUrl: "https://api.deepseek.com",
      proUpstreamModelId: "deepseek-flash",
      freeUpstreamBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      freeUpstreamModelId: "gemini-3.5-flash-lite",
      freeMonthlyOutputTokenLimit: 200_000,
      exposedModels: [],
      deviceLimit: 3,
      publicBaseUrl: "https://api.gestu.ca",
      proxyBaseUrl: "https://api.gestu.ca/v1",
      allowedOrigins: [],
      googleOAuthTokenUrl: "https://oauth2.googleapis.com/token",
      googlePlayApiBase: "https://androidpublisher.googleapis.com",
      rtdnAudience: "", // empty = unset
    };

    const req = makeRtdnPushRequest({ testNotification: { version: "1.0" } });
    const res = await handleRtdn(req, env, config, NOW);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("server_misconfigured");
  });

  it("fails with 401 unauthenticated when RTDN_AUDIENCE does not match token audience", async () => {
    const { privateKeyPem, jwk } = await makeRsaPemPair();
    const kid = "test-kid-wrong-aud";
    const signingKey = await importSigningKey(privateKeyPem);

    const token = await signRs256Jwt(
      signingKey,
      { alg: "RS256", typ: "JWT", kid },
      {
        iss: "https://accounts.google.com",
        aud: "unexpected-audience",
        exp: Math.floor(NOW / 1000) + 3600,
      },
    );

    const originalFetch = globalThis.fetch;
    resetGoogleJwksCacheForTests();
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/certs")) {
        return new Response(
          JSON.stringify({
            keys: [{ kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(url);
    });

    try {
      const kv = fakeKv();
      const env = { PRO_KV: kv } as Env;
      const config: ProxyConfig = {
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
        rtdnAudience: "expected-gestu-aud",
      };

      const req = makeRtdnPushRequest({ testNotification: { version: "1.0" } }, token);
      const res = await handleRtdn(req, env, config, NOW);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe("unauthenticated");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("verifies negative notification (voided purchase) with Play and does NOT revoke if Play still reports ACTIVE", async () => {
    const { privateKeyPem, jwk } = await makeRsaPemPair();
    const kid = "test-kid-auth";
    const signingKey = await importSigningKey(privateKeyPem);

    const audience = "gestu-rtdn-audience";
    const token = await signRs256Jwt(
      signingKey,
      { alg: "RS256", typ: "JWT", kid },
      {
        iss: "https://accounts.google.com",
        aud: audience,
        exp: Math.floor(NOW / 1000) + 3600,
      },
    );

    const purchaseToken = "fake-purchase-token-xyz";
    const tokenHash = await purchaseTokenHash(purchaseToken);
    const keyId = "key-user-test-123";

    const kv = fakeKv();
    const record = newKeyRecord({
      keyId,
      packageName: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "",
      expiresAt: NOW + 30 * 86_400_000,
      status: STATUS.ACTIVE,
      playState: "SUBSCRIPTION_STATE_ACTIVE",
      latestOrderId: "order-123",
      deviceId: "device-1",
      deviceLimit: 2,
      now: NOW,
    });
    await putKeyRecord(kv, record);
    await putPurchaseRecord(kv, {
      tokenHash,
      keyId,
      packageName: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "",
      status: STATUS.ACTIVE,
      expiresAt: NOW + 30 * 86_400_000,
      updatedAt: NOW,
      linkedTokenHash: "",
    });

    const env = {
      PRO_KV: kv,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@gestu.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKeyPem,
    } as Env;

    const config: ProxyConfig = {
      productId: "gestu_pro_monthly",
      basePlanId: "gestu-pro-monthly",
      monthlyTokenLimit: 300_000_000,
      businessMonthlyTokenLimit: 1_000_000_000,
      allowedPackageNames: ["ca.gestu.app"],
      proUpstreamBaseUrl: "https://api.deepseek.com",
      proUpstreamModelId: "deepseek-flash",
      freeUpstreamBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      freeUpstreamModelId: "gemini-3.5-flash-lite",
      freeMonthlyOutputTokenLimit: 200_000,
      exposedModels: [],
      deviceLimit: 3,
      publicBaseUrl: "https://api.gestu.ca",
      proxyBaseUrl: "https://api.gestu.ca/v1",
      allowedOrigins: [],
      googleOAuthTokenUrl: "https://oauth2.googleapis.com/token",
      googlePlayApiBase: "https://androidpublisher.googleapis.com/androidpublisher/v3",
      rtdnAudience: audience,
    };

    const originalFetch = globalThis.fetch;
    resetGoogleJwksCacheForTests();
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/certs")) {
        return new Response(
          JSON.stringify({
            keys: [{ kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/purchases/subscriptionsv2/tokens/")) {
        // Play API disagrees with the voided notification: purchase is still ACTIVE
        const playPurchase: PlaySubscriptionPurchaseV2 = {
          subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
          lineItems: [
            {
              productId: "gestu_pro_monthly",
              expiryTime: new Date(NOW + 30 * 86_400_000).toISOString(),
              autoRenewingPlan: { autoRenewEnabled: true },
            },
          ],
        };
        return new Response(JSON.stringify(playPurchase), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({
            access_token: "fake-google-access-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    });

    try {
      // Send a voided purchase notification
      const voidedPayload = {
        version: "1.0",
        packageName: "ca.gestu.app",
        eventTimeMillis: String(NOW),
        voidedPurchaseNotification: {
          purchaseToken,
          orderId: "order-123",
          refundType: 1,
        },
      };

      const req = makeRtdnPushRequest(voidedPayload, token);
      const res = await handleRtdn(req, env, config, NOW);
      expect(res.status).toBe(200);

      // Verify the key was NOT revoked because Play still reported ACTIVE
      const rawRecord = await kv.get(`key:${keyId}`);
      expect(rawRecord).not.toBeNull();
      const updatedRecord = JSON.parse(rawRecord!);
      expect(updatedRecord.status).toBe(STATUS.ACTIVE);
      expect(updatedRecord.revokedAt).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("verifies negative notification with Play and revokes key if Play confirms CANCELED and expired", async () => {
    const { privateKeyPem, jwk } = await makeRsaPemPair();
    const kid = "test-kid-auth-2";
    const signingKey = await importSigningKey(privateKeyPem);

    const audience = "gestu-rtdn-audience";
    const token = await signRs256Jwt(
      signingKey,
      { alg: "RS256", typ: "JWT", kid },
      {
        iss: "https://accounts.google.com",
        aud: audience,
        exp: Math.floor(NOW / 1000) + 3600,
      },
    );

    const purchaseToken = "fake-purchase-token-revoked";
    const tokenHash = await purchaseTokenHash(purchaseToken);
    const keyId = "key-user-test-revoked";

    const kv = fakeKv();
    const record = newKeyRecord({
      keyId,
      packageName: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "",
      expiresAt: NOW + 30 * 86_400_000,
      status: STATUS.ACTIVE,
      playState: "SUBSCRIPTION_STATE_ACTIVE",
      latestOrderId: "order-123",
      deviceId: "device-1",
      deviceLimit: 2,
      now: NOW,
    });
    await putKeyRecord(kv, record);
    await putPurchaseRecord(kv, {
      tokenHash,
      keyId,
      packageName: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "",
      status: STATUS.ACTIVE,
      expiresAt: NOW + 30 * 86_400_000,
      updatedAt: NOW,
      linkedTokenHash: "",
    });

    const env = {
      PRO_KV: kv,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@gestu.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKeyPem,
    } as Env;

    const config: ProxyConfig = {
      productId: "gestu_pro_monthly",
      basePlanId: "gestu-pro-monthly",
      monthlyTokenLimit: 300_000_000,
      businessMonthlyTokenLimit: 1_000_000_000,
      allowedPackageNames: ["ca.gestu.app"],
      proUpstreamBaseUrl: "https://api.deepseek.com",
      proUpstreamModelId: "deepseek-flash",
      freeUpstreamBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      freeUpstreamModelId: "gemini-3.5-flash-lite",
      freeMonthlyOutputTokenLimit: 200_000,
      exposedModels: [],
      deviceLimit: 3,
      publicBaseUrl: "https://api.gestu.ca",
      proxyBaseUrl: "https://api.gestu.ca/v1",
      allowedOrigins: [],
      googleOAuthTokenUrl: "https://oauth2.googleapis.com/token",
      googlePlayApiBase: "https://androidpublisher.googleapis.com/androidpublisher/v3",
      rtdnAudience: audience,
    };

    const originalFetch = globalThis.fetch;
    resetGoogleJwksCacheForTests();
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/certs")) {
        return new Response(
          JSON.stringify({
            keys: [{ kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/purchases/subscriptionsv2/tokens/")) {
        // Play API agrees that the subscription is CANCELED and expired
        const playPurchase: PlaySubscriptionPurchaseV2 = {
          subscriptionState: "SUBSCRIPTION_STATE_CANCELED",
          lineItems: [
            {
              productId: "gestu_pro_monthly",
              expiryTime: new Date(NOW - 1000).toISOString(),
            },
          ],
        };
        return new Response(JSON.stringify(playPurchase), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/token")) {
        return new Response(
          JSON.stringify({
            access_token: "fake-google-access-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    });

    try {
      const revokedPayload = {
        version: "1.0",
        packageName: "ca.gestu.app",
        eventTimeMillis: String(NOW),
        subscriptionNotification: {
          version: "1.0",
          notificationType: RTDN_TYPE.SUBSCRIPTION_REVOKED,
          purchaseToken,
        },
      };

      const req = makeRtdnPushRequest(revokedPayload, token);
      const res = await handleRtdn(req, env, config, NOW);
      expect(res.status).toBe(200);

      // Verify the key WAS revoked because Play confirmed it is expired/not entitled
      const rawRecord = await kv.get(`key:${keyId}`);
      expect(rawRecord).not.toBeNull();
      const updatedRecord = JSON.parse(rawRecord!);
      expect(updatedRecord.status).toBe(STATUS.CANCELED);
      expect(updatedRecord.revokedAt).toBe(NOW);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("revokes on a voided purchase even when Play returns the expired purchase with no line items", async () => {
    // A refunded/voided purchase can come back from Play with the line item *gone* rather than
    // re-attributed. Gating the revocation on a product match left the key live after Play had
    // already stopped recognising the entitlement, which is precisely the case a refund must end.
    const { privateKeyPem, jwk } = await makeRsaPemPair();
    const kid = "test-kid-voided-no-items";
    const signingKey = await importSigningKey(privateKeyPem);

    const audience = "gestu-rtdn-audience";
    const token = await signRs256Jwt(
      signingKey,
      { alg: "RS256", typ: "JWT", kid },
      {
        iss: "https://accounts.google.com",
        aud: audience,
        exp: Math.floor(NOW / 1000) + 3600,
      },
    );

    const purchaseToken = "fake-purchase-token-voided";
    const tokenHash = await purchaseTokenHash(purchaseToken);
    const keyId = "key-user-voided-no-items";

    const kv = fakeKv();
    await putKeyRecord(
      kv,
      newKeyRecord({
        keyId,
        packageName: "ca.gestu.app",
        productId: "gestu_pro_monthly",
        obfuscatedAccountId: "",
        expiresAt: NOW + 30 * 86_400_000,
        status: STATUS.ACTIVE,
        playState: "SUBSCRIPTION_STATE_ACTIVE",
        latestOrderId: "order-123",
        deviceId: "device-1",
        deviceLimit: 2,
        now: NOW,
      }),
    );
    await putPurchaseRecord(kv, {
      tokenHash,
      keyId,
      packageName: "ca.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "",
      status: STATUS.ACTIVE,
      expiresAt: NOW + 30 * 86_400_000,
      updatedAt: NOW,
      linkedTokenHash: "",
    });

    const env = {
      PRO_KV: kv,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@gestu.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKeyPem,
    } as Env;

    const config: ProxyConfig = {
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
      googlePlayApiBase: "https://androidpublisher.googleapis.com/androidpublisher/v3",
      rtdnAudience: audience,
    };

    const originalFetch = globalThis.fetch;
    resetGoogleJwksCacheForTests();
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.includes("/certs")) {
        return new Response(
          JSON.stringify({ keys: [{ kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/purchases/subscriptionsv2/tokens/")) {
        // Refunded: Play no longer reports a line item for the product.
        return new Response(
          JSON.stringify({
            subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
            lineItems: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/token")) {
        return new Response(JSON.stringify({ access_token: "fake-google-access-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });

    try {
      const res = await handleRtdn(
        makeRtdnPushRequest(
          {
            version: "1.0",
            packageName: "ca.gestu.app",
            eventTimeMillis: String(NOW),
            voidedPurchaseNotification: { purchaseToken, orderId: "order-123", refundType: 1 },
          },
          token,
        ),
        env,
        config,
        NOW,
      );
      expect(res.status).toBe(200);

      const updatedRecord = JSON.parse((await kv.get(`key:${keyId}`))!);
      expect(updatedRecord.status).toBe(STATUS.EXPIRED);
      expect(updatedRecord.revokedAt).toBe(NOW);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
