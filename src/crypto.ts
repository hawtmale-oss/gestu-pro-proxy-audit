/**
 * WebCrypto primitives: PKCS#8 PEM import, RS256 JWTs, and JWT verification.
 *
 * `crypto.subtle` is the only signing implementation available in a Worker, and it is the right
 * one: key material never leaves the isolate, and there is no chance of a hand-rolled RSA. The
 * only non-standard bit is base64url without padding (see `base64.ts`) and the PKCS#8 PEM
 * unwrapping below, because a Google service-account key file hands over PEM text rather than DER.
 */

import { base64UrlDecode, base64UrlEncode, sha256Hex, utf8 } from "./base64";

/** Signing/verification algorithms this file can derive from a PEM header. */
export type PemAlgorithm = "RS256" | "ES256";

export interface ParsedPem {
  /** `BEGIN PRIVATE KEY` → `pkcs8`, `BEGIN PUBLIC KEY` → `spki`. */
  type: "pkcs8" | "spki";
  algorithm: PemAlgorithm;
  bytes: Uint8Array;
}

const PRIVATE_KEY_HEADER = /^-----BEGIN (RSA |EC )?PRIVATE KEY-----$/;
const PUBLIC_KEY_HEADER = /^-----BEGIN (RSA |EC )?PUBLIC KEY-----$/;

/**
 * Parses a PKCS#8 (private) or SPKI (public) PEM block.
 *
 * Accepts what Google's JSON key file actually contains (`BEGIN PRIVATE KEY`, no algorithm name
 * in the header → RSA → RS256) as well as the `RSA PRIVATE KEY` spelling some tooling emits. The
 * EC spellings are recognised so the failure mode is a clear "use an RSA key" message rather than
 * an import error from WebCrypto.
 */
export function parsePem(pem: string): ParsedPem {
  const lines = pem
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const beginIndex = lines.findIndex((line) => line.startsWith("-----BEGIN"));
  if (beginIndex < 0) throw new Error("PEM: no BEGIN line found");
  const header = lines[beginIndex] as string;
  const isEc = header.includes(" EC ") || header.startsWith("-----BEGIN EC");
  const isPrivate = PRIVATE_KEY_HEADER.test(header);
  const isPublic = PUBLIC_KEY_HEADER.test(header);
  if (!isPrivate && !isPublic) {
    throw new Error("PEM: expected a PKCS#8 PRIVATE KEY or an SPKI PUBLIC KEY block");
  }
  const body = lines
    .slice(beginIndex + 1)
    .filter((line) => !line.startsWith("-----END"))
    .join("");
  if (body === "") throw new Error("PEM: empty body");
  return {
    type: isPrivate ? "pkcs8" : "spki",
    algorithm: isEc ? "ES256" : "RS256",
    bytes: base64UrlDecode(body),
  };
}

/**
 * Imports a PKCS#8 PEM private key for RS256 signing.
 *
 * `importKey("pkcs8", …)` is the WebCrypto spelling for "this DER is an unencrypted PKCS#8
 * PrivateKeyInfo"; Google service-account keys are exactly that.
 */
export async function importSigningKey(pem: string): Promise<CryptoKey> {
  const parsed = parsePem(pem);
  if (parsed.type !== "pkcs8") throw new Error("signing key: expected a PRIVATE KEY block");
  if (parsed.algorithm !== "RS256") {
    throw new Error("signing key: only RSA keys (RS256) are supported for Google service accounts");
  }
  return crypto.subtle.importKey(
    "pkcs8",
    parsed.bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Imports an SPKI public key for RS256 verification (used to verify Pub/Sub OIDC tokens). */
export async function importVerificationKey(pem: string): Promise<CryptoKey> {
  const parsed = parsePem(pem);
  if (parsed.type !== "spki") throw new Error("verification key: expected a PUBLIC KEY block");
  return crypto.subtle.importKey(
    "spki",
    parsed.bytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/**
 * Imports an SPKI public key for ES256 verification (organisational licence tokens).
 *
 * Separate from [importVerificationKey] rather than one function that sniffs the curve: the two
 * carry different WebCrypto algorithm objects, and a caller that gets the wrong one should fail at
 * import with a clear message instead of at every verification with a false.
 *
 * **`parsed.algorithm` is deliberately not consulted.** It is inferred from the PEM header, and
 * that inference cannot see the curve of a public key: an EC public key is an SPKI block whose
 * header reads only `PUBLIC KEY`, while the `EC` marker this codebase looks for appears in SEC1
 * *private* keys. Trusting it here rejected every licence the operator tool issued. WebCrypto is
 * the real authority — it rejects DER that is not an EC SPKI key — and a key on a different curve
 * simply fails to verify a P-256 signature, so nothing is weakened by not asking.
 */
export async function importEcdsaVerificationKey(pem: string): Promise<CryptoKey> {
  const parsed = parsePem(pem);
  if (parsed.type !== "spki") {
    throw new Error("licence key: expected a PUBLIC KEY block (SPKI), not a private key");
  }
  return crypto.subtle.importKey(
    "spki",
    parsed.bytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/**
 * Verifies an ES256 signature over `signingInput`.
 *
 * WebCrypto encodes ECDSA signatures as raw `r||s` (64 bytes for P-256), which is also what the
 * issuing tool asks Node for (`dsaEncoding: "ieee-p1363"`). ASN.1/DER signatures are the other
 * common encoding and will not verify here — deliberately, because silently accepting both would
 * mean two different byte strings authenticating the same licence.
 */
export async function verifyEs256Signature(
  key: CryptoKey,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, utf8(signingInput));
}

/**
 * Imports an EC P-256 PKCS#8 private key for ES256 signing (licence issuance).
 */
export async function importEcdsaSigningKey(pem: string): Promise<CryptoKey> {
  const parsed = parsePem(pem);
  if (parsed.type !== "pkcs8") {
    throw new Error("licence signing key: expected a PKCS#8 PRIVATE KEY block");
  }
  return crypto.subtle.importKey(
    "pkcs8",
    parsed.bytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * Signs `signingInput` with an ES256 (P-256) key.
 * WebCrypto produces the raw IEEE P1363 `r||s` 64-byte signature required by `verifyEs256Signature`.
 */
export async function signEs256(key: CryptoKey, signingInput: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput));
  return new Uint8Array(signature);
}

/**
 * Verifies an HMAC-SHA256 hex signature over data (used by payment webhooks).
 */
export async function verifyHmacSha256(secret: string, data: string, signatureHex: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      utf8(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const match = signatureHex.trim().toLowerCase().match(/.{1,2}/g);
    if (!match) return false;
    const sigBytes = new Uint8Array(match.map((byte) => parseInt(byte, 16)));
    return crypto.subtle.verify("HMAC", key, sigBytes, utf8(data));
  } catch {
    return false;
  }
}

/**
 * Signs `header.payload` as an RS256 JWT.
 *
 * Compact JWS form (`base64url(header).base64url(payload).base64url(signature)`), with no padding
 * on any segment — which is what Google's OAuth2 assertion flow requires.
 */
export async function signRs256Jwt(key: CryptoKey, header: object, payload: object): Promise<string> {
  const encodedHeader = base64UrlEncode(utf8(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(utf8(JSON.stringify(payload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    utf8(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Decoded, *unverified* claims of a JWT. Callers must verify before trusting anything here. */
export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

/** Splits a compact JWS and decodes its JSON segments. Does **not** verify the signature. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("jwt: expected three segments");
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const header: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader)));
  const claims: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedClaims)));
  if (header === null || typeof header !== "object" || claims === null || typeof claims !== "object") {
    throw new Error("jwt: header or claims are not objects");
  }
  return {
    header: header as Record<string, unknown>,
    claims: claims as Record<string, unknown>,
    signingInput: `${encodedHeader}.${encodedClaims}`,
    signature: base64UrlDecode(encodedSignature),
  };
}

/** Verifies an RS256 JWT signature against an imported public key. */
export async function verifyRs256Signature(key: CryptoKey, jwt: DecodedJwt): Promise<boolean> {
  return crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    jwt.signature,
    utf8(jwt.signingInput),
  );
}

/**
 * The `keyId` half of a JWK: the RFC 7638 thumbprint, base64url encoded.
 *
 * Google's Pub/Sub OIDC tokens carry `kid` values that are these thumbprints. Only `n` and `e` are
 * used for an RSA key, and the member order below is the canonical one the RFC requires.
 */
export async function jwkThumbprint(jwk: { kty: string; n: string; e: string }): Promise<string> {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  const digest = await crypto.subtle.digest("SHA-256", utf8(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

/** SHA-256 of a string, lowercase hex — the KV key of a hashed credential. */
export { sha256Hex };
