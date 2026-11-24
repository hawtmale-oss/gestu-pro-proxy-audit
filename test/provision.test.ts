import { describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "../src/base64";
import type { Env } from "../src/config";
import { readConfig } from "../src/config";
import { PRODUCT_ID_FREE, PRODUCT_ID_PRO } from "../src/constants";
import { importSigningKey } from "../src/crypto";
import { handleProvisionKey } from "../src/provision";
import { findKeyByVirtualKey } from "../src/store";
import { fakeKv } from "./fake-kv";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const FUTURE = "2026-12-15T12:00:00Z";

async function makeRsaPrivateKeyPem(): Promise<string> {
  const { subtle } = (globalThis as unknown as { crypto: Crypto }).crypto;
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
  const pkcs8 = (await subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const base64 = base64UrlEncode(new Uint8Array(pkcs8)).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const lines = padded.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  // Smoke check importSigningKey works with generated PEM
  await importSigningKey(pem);
  return pem;
}

function provisionBody(productId: string, token: string): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      productId,
      packageName: "app.gestu.assistant",
      purchaseTokens: [token],
      deviceId: "dev-1",
      obfuscatedAccountId: "",
      appVersion: "1.6.0",
    }),
  };
}

describe("handleProvisionKey two-tier Play verification (Pro only)", () => {
  it("provisions gestu_pro_monthly, stores the verified productId, and denies Free/Lite ids", async () => {
    const privateKeyPem = await makeRsaPrivateKeyPem();
    const kv = fakeKv();
    const env: Env = {
      PRO_KV: kv,
      GESTU_ALLOWED_PACKAGE_NAMES: "app.gestu.assistant",
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@gestu.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKeyPem,
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/token")) {
        return new Response(JSON.stringify({ access_token: "oauth-tok", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/tokens/tok-pro-yearly")) {
        // The yearly cadence is a base plan *inside* the one product, so it provisions the same key.
        return new Response(
          JSON.stringify({
            subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
            acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
            lineItems: [
              {
                productId: PRODUCT_ID_PRO,
                expiryTime: "2027-11-15T12:00:00Z",
                offerDetails: { basePlanId: "gestu-pro-yearly" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/tokens/tok-pro")) {
        return new Response(
          JSON.stringify({
            subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
            acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
            lineItems: [{ productId: PRODUCT_ID_PRO, expiryTime: FUTURE }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    try {
      // 1. Provision the one Pro product.
      const proRes = await handleProvisionKey(
        new Request("https://api.gestu.ca/api/provision-key", provisionBody(PRODUCT_ID_PRO, "tok-pro")),
        env,
        readConfig(env),
        NOW,
      );
      expect(proRes.status).toBe(200);
      const proBody = (await proRes.json()) as { ok: boolean; virtualKey: string };
      expect(proBody.ok).toBe(true);
      const proRecord = await findKeyByVirtualKey(kv, proBody.virtualKey);
      expect(proRecord?.productId).toBe(PRODUCT_ID_PRO);

      // 2. The yearly base plan inside the same product provisions too.
      const yearlyRes = await handleProvisionKey(
        new Request("https://api.gestu.ca/api/provision-key", provisionBody(PRODUCT_ID_PRO, "tok-pro-yearly")),
        env,
        readConfig(env),
        NOW + 500,
      );
      expect(yearlyRes.status).toBe(200);
      const yearlyBody = (await yearlyRes.json()) as { ok: boolean; expiresAt: number };
      expect(yearlyBody.ok).toBe(true);
      expect(yearlyBody.expiresAt).toBe(Date.parse("2027-11-15T12:00:00Z"));

      // 3. The retired Free id is not a Play product: never minted on this path.
      const freeRes = await handleProvisionKey(
        new Request("https://api.gestu.ca/api/provision-key", provisionBody(PRODUCT_ID_FREE, "tok-pro")),
        env,
        readConfig(env),
        NOW + 1000,
      );
      const freeBody = (await freeRes.json()) as { ok: boolean; reason: string };
      expect(freeBody.ok).toBe(false);
      expect(freeBody.reason).toBe("not_verified");

      // 3. The retired Lite product id is refused: there is no Lite tier.
      const liteRes = await handleProvisionKey(
        new Request("https://api.gestu.ca/api/provision-key", provisionBody("gestu_lite_monthly", "tok-pro")),
        env,
        readConfig(env),
        NOW + 2000,
      );
      const liteBody = (await liteRes.json()) as { ok: boolean; reason: string };
      expect(liteBody.ok).toBe(false);
      expect(liteBody.reason).toBe("not_verified");

      // 4. An unknown product id is denied.
      const badRes = await handleProvisionKey(
        new Request("https://api.gestu.ca/api/provision-key", provisionBody("gestu_unknown_tier", "tok-pro")),
        env,
        readConfig(env),
        NOW + 3000,
      );
      const badBody = (await badRes.json()) as { ok: boolean; reason: string };
      expect(badBody.ok).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
