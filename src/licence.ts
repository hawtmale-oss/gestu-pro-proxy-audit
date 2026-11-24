/**
 * Organisational licence tokens: the B2B half of the plan, which never touches Google Play.
 *
 * A business buys by invoice, the operator signs a licence with a private key that never leaves
 * their machine, and the customer pastes the token into Settings. This module is the *verifying*
 * half — it parses a token, checks the signature against the operator's public key, and reports
 * what the claims mean. It mints nothing; `licence-provision.ts` does that.
 *
 * ## Why signed tokens rather than a list of keys
 *
 * A list would mean a redeploy per customer and a secret that grows with the customer count. A
 * signed token needs no server state to *authenticate*: the signature is the proof, the public key
 * is the only thing the Worker holds, and a new customer is a new signature rather than a new
 * deployment. What still needs state is revocation and the device binding, and those live in KV
 * exactly as they do for a Play subscription.
 *
 * ## Format
 *
 * `GESTU1.<base64url(claims JSON)>.<base64url(signature)>`
 *
 * ES256 — ECDSA over P-256 with SHA-256 — in WebCrypto's raw `r||s` encoding, over the literal
 * string `GESTU1.<claims segment>`. This is a JWS with the header dropped: there is exactly one
 * algorithm a licence may use, so a header would be a field an attacker could lie in and nothing
 * else. The version lives in the prefix instead, where a parser can see it before it has to
 * understand anything.
 *
 * ## What this deliberately does not do
 *
 * It does not consult the network, the clock's timezone, or KV. Everything it needs is in the
 * token and the public key, which is what makes the whole scheme testable and what keeps a
 * licence check off the request path of a chat turn.
 */

import { base64UrlDecode } from "./base64";
import { DENIAL, LICENCE_PREFIX } from "./constants";
import { importEcdsaVerificationKey, verifyEs256Signature } from "./crypto";

export { LICENCE_PREFIX } from "./constants";

/** The only licence format version this Worker understands. */
export const LICENCE_VERSION = 1;

/**
 * `seats` value meaning "no device cap at all" — what the business tier is sold as.
 *
 * A sentinel rather than a second boolean field: the token already has one field answering "how
 * many devices", and two fields that can contradict each other is a worse format than one field
 * with three documented meanings. Nothing types this by accident — the issuing tool only writes it
 * through `--unlimited`, never through `--seats`.
 */
export const UNLIMITED_SEATS = -1;

/** The claims an operator signs. Every field is required in the signed bytes. */
export interface LicenceClaims {
  /** Format version. See [LICENCE_VERSION]. */
  v: number;
  /** Key ID identifying which public key signed this licence (for key rotation). */
  kid?: string;
  /** Licence id — stable for the life of the agreement. The KV index is keyed by its hash. */
  lic: string;
  /** Organisation name, shown in the app so a user can see whose licence they are on. */
  org: string;
  /** Issued at, epoch millis. */
  iat: number;
  /** Expires at, epoch millis. `0` means the licence does not expire. */
  exp: number;
  /**
   * Maximum devices. `> 0` is that many; `0` means "use the server's configured device limit";
   * [UNLIMITED_SEATS] means no cap, which is what the business tier is sold as.
   */
  seats: number;
  /**
   * Invoice reference the licence was issued against — for this operator, the Venn invoice.
   *
   * Optional, never enforced, and carried only so a licence can be reconciled with the payment
   * that produced it. It is signed like everything else, so it cannot be edited after issue.
   */
  ref: string;
}

/** A parsed, **unverified** token. Nothing here may be trusted before [verifyLicence]. */
export interface ParsedLicence {
  claims: LicenceClaims;
  /** The exact string the signature covers: `GESTU1.<claims segment>`. */
  signingInput: string;
  signature: Uint8Array;
}

/** Refusal reasons reuse the client's existing vocabulary, so the app needs no new enum value. */
export type LicenceVerification =
  | { ok: true; claims: LicenceClaims }
  | { ok: false; reason: string; message: string };

export type PublicKeyResolver =
  | string
  | Record<string, string>
  | ((kid: string) => Promise<string | null> | string | null);

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Splits and decodes a token without verifying it.
 *
 * Throws on anything malformed. The caller is [verifyLicence], which turns every throw into a
 * refusal — a parser that returned a half-built object would push the "is this trustworthy?"
 * question onto whoever read the fields next.
 */
export function parseLicenceToken(token: string): ParsedLicence {
  const trimmed = token.trim();
  if (!trimmed.startsWith(LICENCE_PREFIX)) {
    throw new Error(`licence: expected a token beginning with ${LICENCE_PREFIX}`);
  }
  const rest = trimmed.slice(LICENCE_PREFIX.length);
  // The signature segment is base64url and cannot contain a dot, so the *last* dot is the
  // separator. Splitting on the first would break the moment a claims field ever encodes one.
  const separator = rest.lastIndexOf(".");
  if (separator <= 0 || separator === rest.length - 1) {
    throw new Error("licence: expected a claims segment and a signature segment");
  }
  const claimsSegment = rest.slice(0, separator);
  const signatureSegment = rest.slice(separator + 1);
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(claimsSegment)));
  } catch {
    throw new Error("licence: claims are not base64url JSON");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("licence: claims are not a JSON object");
  }
  const record = decoded as Record<string, unknown>;
  const claims: LicenceClaims = {
    v: readNumber(record["v"]),
    lic: readText(record["lic"]),
    org: readText(record["org"]),
    iat: readNumber(record["iat"]),
    exp: readNumber(record["exp"]),
    seats: readNumber(record["seats"]),
    ref: readText(record["ref"]),
  };
  const kid = readText(record["kid"]);
  if (kid !== "") claims.kid = kid;

  return {
    claims,
    signingInput: `${LICENCE_PREFIX}${claimsSegment}`,
    signature: base64UrlDecode(signatureSegment),
  };
}

/**
 * Verifies a licence token end to end.
 *
 * The order matters and mirrors `provision.ts`: the *key must be configured* before anything else
 * is considered, because a Worker that holds no public key cannot tell a forged licence from a
 * real one and must refuse rather than guess. After that the signature is checked before any claim
 * is read, so an unauthenticated `exp` cannot expire somebody else's licence and an
 * unauthenticated `seats` cannot widen a device limit.
 *
 * `packageName` is intentionally absent: a licence is issued to an organisation, not to an app
 * listing, and the Worker already refuses unknown apps on the Play path.
 */
export async function verifyLicence(input: {
  token: string;
  publicKeyPem: PublicKeyResolver;
  now: number;
}): Promise<LicenceVerification> {
  const { token, publicKeyPem, now } = input;

  let parsed: ParsedLicence;
  try {
    parsed = parseLicenceToken(token);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unparseable";
    console.warn(`licence: refused — ${detail}`);
    return { ok: false, reason: DENIAL.INVALID_TOKEN, message: "This licence key is not valid." };
  }

  const tokenKid = parsed.claims.kid || "";
  let resolvedPem = "";
  if (typeof publicKeyPem === "function") {
    resolvedPem = (await publicKeyPem(tokenKid)) || "";
  } else if (typeof publicKeyPem === "object" && publicKeyPem !== null) {
    resolvedPem = (tokenKid && publicKeyPem[tokenKid]) || publicKeyPem["default"] || publicKeyPem[""] || "";
  } else if (typeof publicKeyPem === "string") {
    const trimmed = publicKeyPem.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsedMap = JSON.parse(trimmed) as Record<string, string>;
        resolvedPem = (tokenKid && parsedMap[tokenKid]) || parsedMap["default"] || parsedMap[""] || "";
      } catch {
        resolvedPem = "";
      }
    } else {
      resolvedPem = trimmed;
    }
  }

  if (resolvedPem === "") {
    if (tokenKid !== "") {
      console.warn(`licence: unknown key id "${tokenKid}" — refusing (fail closed)`);
      return { ok: false, reason: DENIAL.INVALID_TOKEN, message: "This licence key is not valid." };
    }
    console.error("licence: GESTU_LICENCE_PUBLIC_KEY is not set — every licence will be refused (fail closed)");
    return {
      ok: false,
      reason: DENIAL.NOT_VERIFIED,
      message: "This server is not configured to accept organisational licences.",
    };
  }

  let key: CryptoKey;
  try {
    key = await importEcdsaVerificationKey(resolvedPem);
  } catch (error) {
    // An operator error, not a user error: the licence may be perfectly good. Fail closed and say
    // so in the log, because the alternative — treating an unreadable key as "no licence" — would
    // look to a paying customer exactly like a forged one.
    const detail = error instanceof Error ? error.message : "unreadable";
    console.error(`licence: public key could not be imported (${detail}) — refusing (fail closed)`);
    return {
      ok: false,
      reason: DENIAL.NOT_VERIFIED,
      message: "This server is not configured to accept organisational licences.",
    };
  }

  const signatureOk = await verifyEs256Signature(key, parsed.signingInput, parsed.signature);
  if (!signatureOk) {
    console.warn(`licence: signature did not verify for ${parsed.claims.lic || "(unreadable id)"}`);
    return { ok: false, reason: DENIAL.INVALID_TOKEN, message: "This licence key is not valid." };
  }

  const { claims } = parsed;
  if (claims.v !== LICENCE_VERSION) {
    console.warn(`licence: unsupported version ${claims.v} for ${claims.lic || "(unreadable id)"}`);
    return {
      ok: false,
      reason: DENIAL.INVALID_TOKEN,
      message: "This licence key was issued for a newer version of Gestu.",
    };
  }
  if (claims.lic === "") {
    return { ok: false, reason: DENIAL.INVALID_TOKEN, message: "This licence key is not valid." };
  }
  if (claims.exp > 0 && now > claims.exp) {
    console.warn(`licence: ${claims.lic} expired at ${claims.exp}`);
    return {
      ok: false,
      reason: DENIAL.EXPIRED,
      message: "This organisation's licence has expired. Contact whoever issued it.",
    };
  }

  return { ok: true, claims };
}

/**
 * The KV key one **device's** key record for a licence is indexed under.
 *
 * Per device, not per licence, and that is the whole point. A licence is one credential shared by a
 * whole company, and every device that redeems it mints its own key — so rotating a device's secret
 * (a reinstall) touches only that device. Indexing by licence alone meant every provisioning
 * rotated the single shared key and revoked the superseded record, leaving only the most recent
 * device able to authenticate; a tier sold as "unlimited users" has to mean they all work at once.
 *
 * The licence id is stored in the clear because it is not a credential — the *signature* is what
 * proves a licence, and the id is already carried in the key record's account field. Device ids are
 * random per install, and the value is only ever the key id.
 */
export function licenceIndexKey(licenceId: string, deviceId: string): string {
  return `licence:${licenceId}:${deviceId}`;
}

/** Prefix under which every device record of one licence lives, for counting and sweeping. */
export function licenceDevicePrefix(licenceId: string): string {
  return `licence:${licenceId}:`;
}

/**
 * Tombstone marking a whole licence as revoked, independent of any device record.
 *
 * Distinct from a revoked *device*: this is the operator ending the agreement, and it has to stop
 * both the devices already holding keys and any device that tries to redeem afterwards.
 */
export function licenceRevokedKey(licenceId: string): string {
  return `licence-revoked:${licenceId}`;
}
