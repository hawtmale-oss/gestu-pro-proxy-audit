import { describe, expect, it, vi } from "vitest";
import { base64UrlEncode, sha256Hex, utf8 } from "../src/base64";
import { buildOAuthAssertion, MissingServiceAccountError, requireServiceAccount, summarizeGoogleError } from "../src/google";
import { decodeJwt, importSigningKey, importVerificationKey, parsePem, signRs256Jwt, verifyRs256Signature } from "../src/crypto";
import type { Env } from "../src/config";

/**
 * The WebCrypto surface, taken from the global object rather than the bare `crypto` identifier.
 *
 * `@cloudflare/workers-types` scopes its globals (including `crypto`) inside the Workers module
 * namespace, so under a plain `tsc --noEmit` the bare identifier is not typed. At runtime — in the
 * Worker and in Vitest's Node environment alike — it is the standard global.
 */
const webcrypto = (globalThis as unknown as { crypto: Crypto }).crypto;

/** Generates a throwaway RSA key pair and exports it as PEM. */
async function makeRsaPemPair(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
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
  return { privateKeyPem: toPem(pkcs8, "PRIVATE KEY"), publicKeyPem: toPem(spki, "PUBLIC KEY") };
}

describe("parsePem", () => {
  it("unwraps a PKCS#8 private key and calls it RS256", async () => {
    const { privateKeyPem } = await makeRsaPemPair();
    const parsed = parsePem(privateKeyPem);
    expect(parsed.type).toBe("pkcs8");
    expect(parsed.algorithm).toBe("RS256");
    expect(parsed.bytes.length).toBeGreaterThan(1000);
  });

  it("unwraps an SPKI public key", async () => {
    const { publicKeyPem } = await makeRsaPemPair();
    expect(parsePem(publicKeyPem).type).toBe("spki");
  });

  it("tolerates CRLF line endings, which is what a Windows-set secret often contains", async () => {
    const { privateKeyPem } = await makeRsaPemPair();
    const parsed = parsePem(privateKeyPem.replace(/\n/g, "\r\n"));
    expect(parsed.type).toBe("pkcs8");
    expect(parsed.bytes).toEqual(parsePem(privateKeyPem).bytes);
  });

  it("rejects a literal backslash-n PEM, which is the mistake an operator actually makes", async () => {
    const { privateKeyPem } = await makeRsaPemPair();
    // `wrangler secret put` reads the value verbatim: pasting a JSON-escaped key leaves the
    // escapes in place. Failing here is the point — silently importing garbage would fail later,
    // at the first provisioning attempt, where it is harder to diagnose.
    const escaped = privateKeyPem.replace(/\n/g, "\\n");
    expect(() => parsePem(escaped)).toThrow();
  });

  it("fails loudly on anything that is not a key", () => {
    expect(() => parsePem("not a pem")).toThrow(/BEGIN/);
    expect(() => parsePem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")).toThrow();
  });
});

describe("RS256 JWT", () => {
  it("signs a compact JWS whose signature verifies, with unpadded base64url segments", async () => {
    const { privateKeyPem, publicKeyPem } = await makeRsaPemPair();
    const signingKey = await importSigningKey(privateKeyPem);
    const verificationKey = await importVerificationKey(publicKeyPem);

    const token = await signRs256Jwt(
      signingKey,
      { alg: "RS256", typ: "JWT" },
      { iss: "svc@example.iam.gserviceaccount.com", scope: "scope", aud: "aud", iat: 1, exp: 2 },
    );

    expect(token.split(".")).toHaveLength(3);
    for (const segment of token.split(".")) expect(segment).not.toContain("=");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const decoded = decodeJwt(token);
    expect(decoded.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decoded.claims["iss"]).toBe("svc@example.iam.gserviceaccount.com");
    expect(await verifyRs256Signature(verificationKey, decoded)).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const { privateKeyPem, publicKeyPem } = await makeRsaPemPair();
    const token = await signRs256Jwt(await importSigningKey(privateKeyPem), { alg: "RS256", typ: "JWT" }, {
      sub: "honest",
    });
    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = `${header}.${base64UrlEncode(utf8(JSON.stringify({ sub: "attacker" })))}.${signature}`;
    expect(await verifyRs256Signature(await importVerificationKey(publicKeyPem), decodeJwt(forged))).toBe(false);
  });

  it("rejects a JWS with the wrong number of segments", () => {
    expect(() => decodeJwt("a.b")).toThrow(/three segments/);
  });
});

describe("buildOAuthAssertion", () => {
  it("carries exactly the claims Google's JWT-bearer flow requires", async () => {
    const { privateKeyPem, publicKeyPem } = await makeRsaPemPair();
    const now = Date.UTC(2026, 8, 11, 10, 0, 0);
    const tokenUrl = "https://oauth2.googleapis.com/token";
    const assertion = await buildOAuthAssertion({
      account: { clientEmail: "gestu-pro@project.iam.gserviceaccount.com", privateKeyPem },
      tokenUrl,
      now,
    });

    const decoded = decodeJwt(assertion);
    expect(decoded.header["alg"]).toBe("RS256");
    expect(decoded.header["typ"]).toBe("JWT");
    expect(decoded.claims["iss"]).toBe("gestu-pro@project.iam.gserviceaccount.com");
    expect(decoded.claims["scope"]).toBe("https://www.googleapis.com/auth/androidpublisher");
    expect(decoded.claims["aud"]).toBe(tokenUrl);
    expect(decoded.claims["iat"]).toBe(Math.floor(now / 1000));
    expect(decoded.claims["exp"]).toBe(Math.floor(now / 1000) + 3600);
    // No expiry in the past and no lifetime beyond Google's one-hour ceiling.
    expect(Number(decoded.claims["exp"]) - Number(decoded.claims["iat"])).toBe(3600);
    expect(await verifyRs256Signature(await importVerificationKey(publicKeyPem), decoded)).toBe(true);
  });

  it("fails when the key is not an RSA private key", async () => {
    await expect(
      buildOAuthAssertion({
        account: { clientEmail: "x@y.z", privateKeyPem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----" },
        tokenUrl: "https://oauth2.googleapis.com/token",
        now: 0,
      }),
    ).rejects.toThrow(/PRIVATE KEY/);
  });
});

describe("requireServiceAccount", () => {
  const baseEnv = { PRO_KV: {} as KVNamespace } as Env;

  it("fails closed when the secret is missing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => requireServiceAccount(baseEnv)).toThrow(MissingServiceAccountError);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("returns the credentials when both halves are present", () => {
    const env = {
      ...baseEnv,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.iam.gserviceaccount.com",
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    } as Env;
    expect(requireServiceAccount(env).clientEmail).toBe("svc@example.iam.gserviceaccount.com");
  });

  it("still fails closed when only one half is present", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const env = { ...baseEnv, GOOGLE_SERVICE_ACCOUNT_EMAIL: "svc@example.iam.gserviceaccount.com" } as Env;
    expect(() => requireServiceAccount(env)).toThrow(MissingServiceAccountError);
    error.mockRestore();
  });
});

describe("summarizeGoogleError", () => {
  it("collapses whitespace and bounds the length", () => {
    expect(summarizeGoogleError("  {\n  \"error\":  \"nope\"\n}  ")).toBe('{ "error": "nope" }');
    expect(summarizeGoogleError("")).toBe("(empty body)");
    expect(summarizeGoogleError("x".repeat(1000))).toHaveLength(300);
  });
});

describe("sha256Hex re-export", () => {
  it("matches the digest of the raw key, never the key itself", async () => {
    const key = "msk_looksLikeAKey";
    const digest = await sha256Hex(key);
    expect(digest).not.toContain(key);
    expect(digest).toHaveLength(64);
  });
});
