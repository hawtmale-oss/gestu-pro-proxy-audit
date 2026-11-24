import { describe, expect, it } from "vitest";
import { base64UrlEncode, utf8 } from "../src/base64";
import { DENIAL, LICENCE_PREFIX } from "../src/constants";
import {
  LICENCE_VERSION,
  UNLIMITED_SEATS,
  licenceDevicePrefix,
  licenceIndexKey,
  licenceRevokedKey,
  parseLicenceToken,
  verifyLicence,
} from "../src/licence";
import {
  buildClaims,
  buildLicenceToken,
  generateLicenceKeyPair,
  signingInput,
  LICENCE_PREFIX as TOOL_PREFIX,
  LICENCE_VERSION as TOOL_VERSION,
  UNLIMITED_SEATS as TOOL_UNLIMITED_SEATS,
} from "../tools/issue-licence.mjs";

/**
 * The B2B path's contract, tested across the seam that matters.
 *
 * The issuing tool is plain JavaScript and the verifier is TypeScript, so the format is written
 * twice. These tests are the thing that makes that duplication safe: every licence used below is
 * signed by the operator's real tool and checked by the Worker's real verifier, so a change to
 * either side that the other does not follow fails here rather than in front of a customer.
 */

const pair = generateLicenceKeyPair();

/** A licence issued now, valid for a year, on 5 seats, against a named invoice. */
function issuedLicence(overrides: { expiresAt?: number; seats?: number } = {}) {
  const claims = buildClaims({
    licenceId: "acme-2026",
    organisation: "Acme Corp",
    issuedAt: Date.UTC(2026, 0, 1),
    expiresAt: overrides.expiresAt ?? Date.UTC(2027, 0, 1),
    seats: overrides.seats ?? 5,
    invoiceRef: "INV-1042",
  });
  return { claims, token: buildLicenceToken(claims, pair.privateKey) };
}

describe("licence format", () => {
  it("agrees between the issuing tool and the Worker", () => {
    // If these ever diverge, every licence in the field stops verifying at once.
    expect(TOOL_PREFIX).toBe(LICENCE_PREFIX);
    expect(TOOL_VERSION).toBe(LICENCE_VERSION);
    // And this one is worse than a failed verification: a disagreement here would silently issue
    // a licence meaning "no device cap" to a customer who was sold five seats.
    expect(TOOL_UNLIMITED_SEATS).toBe(UNLIMITED_SEATS);
  });

  it("carries an unlimited seat count through the round trip", async () => {
    const claims = buildClaims({
      licenceId: "acme-unlimited",
      organisation: "Acme Corp",
      issuedAt: Date.UTC(2026, 0, 1),
      expiresAt: 0,
      seats: UNLIMITED_SEATS,
      invoiceRef: "INV-2001",
    });
    const result = await verifyLicence({
      token: buildLicenceToken(claims, pair.privateKey),
      publicKeyPem: pair.publicKey,
      now: Date.UTC(2026, 5, 1),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.seats).toBe(UNLIMITED_SEATS);
  });

  it("survives a round trip through the tool and the verifier", async () => {
    const { claims, token } = issuedLicence();
    const result = await verifyLicence({
      token,
      publicKeyPem: pair.publicKey,
      now: Date.UTC(2026, 5, 1),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims.lic).toBe("acme-2026");
    expect(result.claims.org).toBe("Acme Corp");
    expect(result.claims.seats).toBe(5);
    expect(result.claims.ref).toBe("INV-1042");
    expect(result.claims.exp).toBe(claims.exp);
  });

  it("treats an expiry of zero as perpetual", async () => {
    const { token } = issuedLicence({ expiresAt: 0 });
    const result = await verifyLicence({
      token,
      publicKeyPem: pair.publicKey,
      now: Date.UTC(2099, 0, 1),
    });
    expect(result.ok).toBe(true);
  });

  it("supports key rotation via kid", async () => {
    const pair1 = generateLicenceKeyPair();
    const pair2 = generateLicenceKeyPair();

    const claims1 = buildClaims({
      licenceId: "acme-v1",
      organisation: "Acme Corp",
      issuedAt: Date.UTC(2026, 0, 1),
      expiresAt: Date.UTC(2027, 0, 1),
      seats: 5,
      invoiceRef: "INV-1",
      kid: "key-v1",
    });
    const token1 = buildLicenceToken(claims1, pair1.privateKey);

    const claims2 = buildClaims({
      licenceId: "acme-v2",
      organisation: "Acme Corp",
      issuedAt: Date.UTC(2026, 0, 1),
      expiresAt: Date.UTC(2027, 0, 1),
      seats: 10,
      invoiceRef: "INV-2",
      kid: "key-v2",
    });
    const token2 = buildLicenceToken(claims2, pair2.privateKey);

    const keyMap = {
      "key-v1": pair1.publicKey,
      "key-v2": pair2.publicKey,
    };

    // Verify using key map
    const res1 = await verifyLicence({ token: token1, publicKeyPem: keyMap, now: Date.UTC(2026, 5, 1) });
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      expect(res1.claims.kid).toBe("key-v1");
      expect(res1.claims.seats).toBe(5);
    }

    const res2 = await verifyLicence({ token: token2, publicKeyPem: keyMap, now: Date.UTC(2026, 5, 1) });
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.claims.kid).toBe("key-v2");
      expect(res2.claims.seats).toBe(10);
    }

    // Verify using JSON map string
    const jsonMap = JSON.stringify(keyMap);
    const resJson = await verifyLicence({ token: token2, publicKeyPem: jsonMap, now: Date.UTC(2026, 5, 1) });
    expect(resJson.ok).toBe(true);

    // Verify using async resolver function
    const resolver = async (kid: string) => keyMap[kid as keyof typeof keyMap] ?? null;
    const resFn = await verifyLicence({ token: token1, publicKeyPem: resolver, now: Date.UTC(2026, 5, 1) });
    expect(resFn.ok).toBe(true);
  });

  it("refuses a token when its kid is not in the key registry", async () => {
    const other = generateLicenceKeyPair();
    const claims = buildClaims({
      licenceId: "unknown-key",
      organisation: "Unknown",
      issuedAt: Date.UTC(2026, 0, 1),
      expiresAt: Date.UTC(2027, 0, 1),
      seats: 1,
      invoiceRef: "",
      kid: "non-existent-kid",
    });
    const token = buildLicenceToken(claims, other.privateKey);
    const result = await verifyLicence({
      token,
      publicKeyPem: { "key-v1": pair.publicKey },
      now: Date.UTC(2026, 5, 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(DENIAL.INVALID_TOKEN);
    }
  });

  it("namespaces a licence device away from purchase token hashes", () => {
    // A licence's index entries and the Play purchase index share one KV namespace, so the prefix is
    // what stops one from ever resolving to the other.
    expect(licenceIndexKey("acme-2026", "device-a")).toBe("licence:acme-2026:device-a");
    expect(licenceIndexKey("acme-2026", "device-a").startsWith(licenceDevicePrefix("acme-2026"))).toBe(true);
    // The revocation tombstone must sit *outside* that prefix, or sweeping a licence would count its
    // own tombstone as a device and refuse a seat that was paid for.
    expect(licenceRevokedKey("acme-2026").startsWith(licenceDevicePrefix("acme-2026"))).toBe(false);
  });
});

describe("licence refusals", () => {
  it("refuses an expired licence with the app's own `expired` reason", async () => {
    const { token } = issuedLicence({ expiresAt: Date.UTC(2026, 1, 1) });
    const result = await verifyLicence({
      token,
      publicKeyPem: pair.publicKey,
      now: Date.UTC(2026, 2, 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(DENIAL.EXPIRED);
  });

  it("refuses a licence signed by a different key", async () => {
    const other = generateLicenceKeyPair();
    const claims = buildClaims({
      licenceId: "forged-2026",
      organisation: "Not Acme",
      issuedAt: Date.UTC(2026, 0, 1),
      expiresAt: 0,
      seats: 0,
      invoiceRef: "",
    });
    const result = await verifyLicence({
      token: buildLicenceToken(claims, other.privateKey),
      publicKeyPem: pair.publicKey,
      now: Date.UTC(2026, 5, 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(DENIAL.INVALID_TOKEN);
  });

  it("refuses claims edited after signing, even with a real signature attached", async () => {
    const { claims, token } = issuedLicence({ seats: 5 });
    const signature = token.slice(token.lastIndexOf(".") + 1);
    // Widen the seat count and keep the original signature: the classic forgery attempt.
    const widened = signingInput({ ...claims, seats: 500 });
    const result = await verifyLicence({
      token: `${widened}.${signature}`,
      publicKeyPem: pair.publicKey,
      now: Date.UTC(2026, 5, 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(DENIAL.INVALID_TOKEN);
  });

  it("fails closed when no public key is configured", async () => {
    const { token } = issuedLicence();
    const result = await verifyLicence({ token, publicKeyPem: "", now: Date.UTC(2026, 5, 1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Not `invalid_token`: the licence may be perfectly good, and telling the customer it is not
    // would send them to the operator with the wrong complaint.
    expect(result.reason).toBe(DENIAL.NOT_VERIFIED);
  });

  it("refuses a key that is not an EC public key rather than throwing", async () => {
    const { token } = issuedLicence();
    const result = await verifyLicence({
      token,
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----",
      now: Date.UTC(2026, 5, 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(DENIAL.NOT_VERIFIED);
  });

  it("refuses rubbish, and a token from a different prefix", async () => {
    for (const token of [
      "",
      "hello",
      "GESTU1.",
      "GESTU1.only-one-segment",
      "GESTU9.abc.def",
      `${LICENCE_PREFIX}${base64UrlEncode(utf8("not json"))}.AAAA`,
    ]) {
      const result = await verifyLicence({
        token,
        publicKeyPem: pair.publicKey,
        now: Date.UTC(2026, 5, 1),
      });
      expect(result.ok, `expected ${JSON.stringify(token)} to be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe(DENIAL.INVALID_TOKEN);
    }
  });

  it("refuses a well-formed token whose version this Worker does not know", async () => {
    const claims = buildClaims({
      licenceId: "future-2027",
      organisation: "Future Corp",
      issuedAt: Date.UTC(2026, 0, 1),
      expiresAt: 0,
      seats: 0,
      invoiceRef: "",
    });
    // Signed properly, but claiming a format version that does not exist yet.
    const result = await verifyLicence({
      token: buildLicenceToken({ ...claims, v: 99 }, pair.privateKey),
      publicKeyPem: pair.publicKey,
      now: Date.UTC(2026, 5, 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(DENIAL.INVALID_TOKEN);
  });
});

describe("licence parsing", () => {
  it("coerces junk claim types instead of trusting them", () => {
    const segment = base64UrlEncode(utf8(JSON.stringify({ v: "one", lic: 5, org: null, exp: "soon" })));
    const parsed = parseLicenceToken(`${LICENCE_PREFIX}${segment}.AAAA`);
    expect(parsed.claims.v).toBe(0);
    expect(parsed.claims.lic).toBe("");
    expect(parsed.claims.org).toBe("");
    expect(parsed.claims.exp).toBe(0);
    expect(parsed.claims.seats).toBe(0);
  });

  it("covers exactly the prefix and claims segment with the signature", () => {
    const { token } = issuedLicence();
    const parsed = parseLicenceToken(token);
    // The signature must not cover the signature itself, or nothing could ever verify.
    expect(token.startsWith(parsed.signingInput)).toBe(true);
    expect(parsed.signature.length).toBe(64);
  });
});
