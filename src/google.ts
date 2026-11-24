/**
 * Google service-account OAuth2 and the Play Developer API calls the Worker makes.
 *
 * Two operations, both server-to-server:
 *
 *  1. `GET  …/purchases/subscriptionsv2/tokens/{token}`  — the authoritative purchase state.
 *  2. `POST …/purchases/subscriptions/{productId}/tokens/{token}:acknowledge` — stops Google
 *     refunding an unacknowledged purchase after three days.
 *
 * References:
 *  * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get
 *  * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptions/acknowledge
 *  * https://developers.google.com/identity/protocols/oauth2/service-account#jwt-auth
 *
 * Nothing here ever logs or returns a token, a purchase token, or key material.
 */

import { base64UrlEncode, sha256Hex, utf8 } from "./base64";
import { decodeJwt, importSigningKey, signRs256Jwt, verifyRs256Signature } from "./crypto";
import type { Env, ProxyConfig, ServiceAccount } from "./config";
import { readServiceAccount } from "./config";
import type { PlaySubscriptionPurchaseV2 } from "./play";

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ASSERTION_LIFETIME_SECONDS = 3600;
/** Refresh this long before the token actually expires, so an in-flight request never races it. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** KV cache key for the access token; the value is the token itself, never logged. */
const TOKEN_CACHE_KEY = "google:access-token";

/** A non-2xx answer from Google, classified by whether retrying could plausibly help. */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly transient: boolean;
  /** Google's `error.status` string, e.g. `PERMISSION_DENIED`; safe to log, contains no secrets. */
  readonly reason: string;

  constructor(status: number, reason: string, transient: boolean, message: string) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.reason = reason;
    this.transient = transient;
  }
}

/** The service account is not configured at all. Always a hard failure — never "allow". */
export class MissingServiceAccountError extends Error {
  constructor() {
    super("Google service account is not configured; purchase verification is impossible");
    this.name = "MissingServiceAccountError";
  }
}

/**
 * Returns the configured service account or throws.
 *
 * Deliberately a thrower rather than a nullable getter: every caller of this module is about to
 * make a *trust* decision, and the only safe response to "no credentials" is to stop. `config.ts`
 * logs the reason once per request; this makes it impossible to ignore the `null`.
 */
export function requireServiceAccount(env: Env): ServiceAccount {
  const account = readServiceAccount(env);
  if (account === null) throw new MissingServiceAccountError();
  return account;
}

interface CachedToken {
  token: string;
  /** Epoch millis at which the token stops being usable. */
  expiresAt: number;
}

/** Isolate-local cache. Cheap, and the common case for back-to-back requests. */
let memoryToken: CachedToken | null = null;
/** In-flight exchange, so a burst of parallel requests performs one token exchange. */
let inFlightToken: Promise<CachedToken> | null = null;

/** Test seam: clears the module-scope token cache. */
export function resetTokenCacheForTests(): void {
  memoryToken = null;
  inFlightToken = null;
}

/**
 * Builds and signs the OAuth2 assertion JWT.
 *
 * Claims, all required by Google's JWT-bearer flow: `iss` = service-account email, `scope` =
 * androidpublisher, `aud` = the token endpoint, `iat` = now, `exp` = now + 1 h. The JWT's `kid`
 * header is the PEM's `private_key_id` in Google's own examples; it is optional for this flow and
 * this Worker does not have it (only `client_email` and `private_key` are configured), so the
 * header carries `alg`/`typ` only.
 */
export async function buildOAuthAssertion(input: {
  account: ServiceAccount;
  tokenUrl: string;
  now: number;
  /** Injectable for tests; defaults to a fresh RS256 import of the configured PEM. */
  signingKey?: CryptoKey;
}): Promise<string> {
  const { account, tokenUrl, now } = input;
  const key = input.signingKey ?? (await importSigningKey(account.privateKeyPem));
  const issuedAt = Math.floor(now / 1000);
  return signRs256Jwt(
    key,
    { alg: "RS256", typ: "JWT" },
    {
      iss: account.clientEmail,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: tokenUrl,
      iat: issuedAt,
      exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
    },
  );
}

/**
 * Exchanges the service-account assertion for an access token.
 *
 * Cached twice: in module scope (fast path, lost on isolate recycle) and in KV (survives a cold
 * start). Both are kept for at most `expires_in - 60 s`, so an expired token is never presented.
 * The KV write is skipped when the token is close to expiry, because a write that saves nothing
 * still costs a KV operation.
 */
export async function getAccessToken(env: Env, config: ProxyConfig, now = Date.now()): Promise<string> {
  const account = requireServiceAccount(env);
  if (memoryToken !== null && memoryToken.expiresAt > now) return memoryToken.token;

  if (inFlightToken !== null) return (await inFlightToken).token;

  inFlightToken = (async (): Promise<CachedToken> => {
    const cached = await readCachedToken(env, now);
    if (cached !== null) return cached;

    const assertion = await buildOAuthAssertion({ account, tokenUrl: config.googleOAuthTokenUrl, now });
    const response = await fetch(config.googleOAuthTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_GRANT_TYPE, assertion }).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      // Google's error body explains why (`invalid_grant` for a bad clock or a revoked key), and
      // contains no secret of ours. The assertion itself is never logged.
      throw new GoogleApiError(
        response.status,
        `oauth_${response.status}`,
        response.status >= 500 || response.status === 429,
        `Google OAuth token exchange failed: HTTP ${response.status} ${summarizeGoogleError(text)}`,
      );
    }
    const parsed = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
    const token = typeof parsed.access_token === "string" ? parsed.access_token : "";
    const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 0;
    if (token === "" || expiresIn <= 0) {
      throw new Error("Google OAuth token exchange returned no usable access token");
    }
    const record: CachedToken = { token, expiresAt: now + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS };
    memoryToken = record;
    if (record.expiresAt > now + 5 * 60_000) {
      await writeCachedToken(env, record);
    }
    return record;
  })();

  try {
    return (await inFlightToken).token;
  } finally {
    inFlightToken = null;
  }
}

async function readCachedToken(env: Env, now: number): Promise<CachedToken | null> {
  try {
    const raw = await env.PRO_KV.get(TOKEN_CACHE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as CachedToken;
    if (typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number") return null;
    if (parsed.expiresAt <= now) return null;
    memoryToken = parsed;
    return parsed;
  } catch (error) {
    // A KV miss, an eviction or a torn value must never fail verification: fall through to a
    // fresh exchange.
    console.warn(`oauth: token cache unreadable, exchanging a new one (${describeError(error)})`);
    return null;
  }
}

async function writeCachedToken(env: Env, record: CachedToken): Promise<void> {
  try {
    const ttlSeconds = Math.max(60, Math.floor((record.expiresAt - Date.now()) / 1000));
    await env.PRO_KV.put(TOKEN_CACHE_KEY, JSON.stringify(record), { expirationTtl: ttlSeconds });
  } catch (error) {
    console.warn(`oauth: could not cache the access token (${describeError(error)})`);
  }
}

/** Why a verification attempt failed, without ever carrying the purchase token. */
export type VerifyFailure =
  | { kind: "not_found" }
  | { kind: "malformed"; detail: string }
  | { kind: "transient"; detail: string }
  | { kind: "config"; detail: string };

export type VerifyResult =
  | { ok: true; purchase: PlaySubscriptionPurchaseV2 }
  | { ok: false; failure: VerifyFailure };

/**
 * Fetches the authoritative state of one purchase token from Play.
 *
 * `tokenHash` is the SHA-256 of the purchase token; the raw token is only ever used to build the
 * URL. That keeps the token out of logs, out of error messages and out of the KV keyspace while
 * still allowing a specific attempt to be correlated.
 */
export async function verifySubscriptionPurchase(input: {
  env: Env;
  config: ProxyConfig;
  packageName: string;
  token: string;
  tokenHash: string;
  now?: number;
}): Promise<VerifyResult> {
  const { env, config, packageName, token, tokenHash } = input;
  const now = input.now ?? Date.now();

  let accessToken: string;
  try {
    accessToken = await getAccessToken(env, config, now);
  } catch (error) {
    if (error instanceof MissingServiceAccountError) {
      // The security property of the design: no credentials means no verification, which means
      // no key. Never fall back to trusting the client's claim about the receipt.
      console.error("play: refusing to verify — service account is not configured (fail closed)");
      return { ok: false, failure: { kind: "config", detail: "verification unavailable" } };
    }
    const googleError = error instanceof GoogleApiError ? error : null;
    console.error(`play: OAuth exchange failed for ${shortHash(tokenHash)}: ${describeError(error)}`);
    return {
      ok: false,
      failure: googleError?.transient === false
        ? { kind: "config", detail: "verification unavailable" }
        : { kind: "transient", detail: "verification temporarily unavailable" },
    };
  }

  const url =
    `${config.googlePlayApiBase}/applications/${encodeURIComponent(packageName)}` +
    `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
  } catch (error) {
    console.error(`play: subscriptionsv2 fetch failed for ${shortHash(tokenHash)}: ${describeError(error)}`);
    return { ok: false, failure: { kind: "transient", detail: "play api unreachable" } };
  }

  if (response.status === 200) {
    const text = await response.text();
    try {
      const purchase = JSON.parse(text) as PlaySubscriptionPurchaseV2;
      if (purchase === null || typeof purchase !== "object") {
        return { ok: false, failure: { kind: "malformed", detail: "empty purchase body" } };
      }
      return { ok: true, purchase };
    } catch {
      return { ok: false, failure: { kind: "malformed", detail: "purchase body was not JSON" } };
    }
  }

  const body = await response.text();
  const summary = summarizeGoogleError(body);
  if (response.status === 404 || response.status === 410) {
    // Play does not know this token for this package: it was never issued here, or it belongs to
    // another app. This is the closest thing to "invalid token" the API offers.
    console.warn(`play: purchase token unknown to Play for package ${packageName} (${shortHash(tokenHash)})`);
    return { ok: false, failure: { kind: "not_found" } };
  }
  if (response.status === 401) {
    console.error("play: service account token rejected (401) — check the OAuth clock and the key");
    return { ok: false, failure: { kind: "config", detail: "verification unavailable" } };
  }
  if (response.status === 403) {
    console.error(
      "play: service account lacks Play Console API access (403) — grant it access to this app in Play Console",
    );
    return { ok: false, failure: { kind: "config", detail: "verification unavailable" } };
  }
  if (response.status === 429 || response.status >= 500) {
    console.error(`play: subscriptionsv2 returned HTTP ${response.status} (${summary})`);
    return { ok: false, failure: { kind: "transient", detail: "play api unavailable" } };
  }
  console.error(`play: subscriptionsv2 returned HTTP ${response.status} (${summary})`);
  return { ok: false, failure: { kind: "transient", detail: `unexpected upstream status ${response.status}` } };
}

export type AcknowledgeResult =
  | { ok: true; alreadyAcknowledged: boolean }
  | { ok: false; detail: string };

/**
 * Acknowledges a subscription purchase if Play says it is still pending.
 *
 * Google refunds purchases that stay unacknowledged for three days, so this matters for revenue.
 * A failure here is reported to the caller and logged, but never fails provisioning: the user has
 * a verified purchase and a key either way, and the next provision attempt (or the Play Billing
 * client on the device) can acknowledge it.
 */
export async function acknowledgeSubscription(input: {
  env: Env;
  config: ProxyConfig;
  packageName: string;
  productId: string;
  token: string;
  tokenHash: string;
  acknowledgementState: string;
  now?: number;
}): Promise<AcknowledgeResult> {
  const { env, config, packageName, productId, token, tokenHash, acknowledgementState } = input;
  if (acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED") {
    return { ok: true, alreadyAcknowledged: true };
  }
  if (acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING") {
    // UNSPECIFIED or a missing field: nothing to act on, and not an error.
    return { ok: true, alreadyAcknowledged: acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING" };
  }

  const now = input.now ?? Date.now();
  let accessToken: string;
  try {
    accessToken = await getAccessToken(env, config, now);
  } catch (error) {
    const detail = `acknowledge: no access token (${describeError(error)})`;
    console.error(`${detail} for ${shortHash(tokenHash)}`);
    return { ok: false, detail };
  }

  // `subscriptionId` is the *product* id (`gestu_pro_monthly`). Since 2025-05-21 Google documents
  // it as not required and not recommended for subscriptions with add-ons, but it remains part of
  // the path, so it is sent.
  const url =
    `${config.googlePlayApiBase}/applications/${encodeURIComponent(packageName)}` +
    `/purchases/subscriptions/${encodeURIComponent(productId)}` +
    `/tokens/${encodeURIComponent(token)}:acknowledge`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      // An empty object, not an empty body: the endpoint accepts a JSON body and Google's own
      // sample sends `{}` when there is no developer payload.
      body: "{}",
    });
  } catch (error) {
    const detail = `acknowledge: request failed (${describeError(error)})`;
    console.error(`${detail} for ${shortHash(tokenHash)}`);
    return { ok: false, detail };
  }

  if (response.ok) return { ok: true, alreadyAcknowledged: false };

  const body = await response.text();
  const detail = `acknowledge: HTTP ${response.status} ${summarizeGoogleError(body)}`;
  console.error(`${detail} for ${shortHash(tokenHash)}`);
  return { ok: false, detail };
}

// ---------------------------------------------------------------------------------------------
// Pub/Sub OIDC verification for the RTDN endpoint
// ---------------------------------------------------------------------------------------------

export interface PubSubOidcClaims {
  iss: string;
  aud: string;
  exp: number;
  email?: string;
}

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface GoogleJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

let cachedJwks: { keys: GoogleJwk[]; expiresAt: number } | null = null;

/** Clears the in-memory JWKS cache (for tests). */
export function resetGoogleJwksCacheForTests(): void {
  cachedJwks = null;
}

async function fetchGoogleJwks(now: number): Promise<GoogleJwk[]> {
  if (cachedJwks !== null && cachedJwks.expiresAt > now) return cachedJwks.keys;
  const response = await fetch(GOOGLE_JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new GoogleApiError(response.status, "jwks", true, `JWKS fetch failed: HTTP ${response.status}`);
  const parsed = (await response.json()) as { keys?: GoogleJwk[] };
  const keys = Array.isArray(parsed.keys) ? parsed.keys : [];
  const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] ?? 3600);
  cachedJwks = { keys, expiresAt: now + Math.max(60, maxAge) * 1000 };
  return keys;
}

export type OidcVerification =
  | { ok: true; claims: PubSubOidcClaims }
  | { ok: false; detail: string };

/**
 * Verifies the OIDC bearer token Pub/Sub attaches to a push request.
 *
 * Full verification: RS256 signature against Google's published JWKS (selected by `kid`), `iss`
 * must be a Google issuer, `exp` must be in the future, and `aud` must equal the configured
 * audience. An empty audience means the operator has not configured one yet, and the caller
 * decides what to do — this function never treats "no audience" as "valid".
 * https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions
 */
export async function verifyPubSubOidcToken(input: {
  authorizationHeader: string | null;
  audience: string;
  now?: number;
}): Promise<OidcVerification> {
  const now = input.now ?? Date.now();
  const header = input.authorizationHeader ?? "";
  if (!header.startsWith("Bearer ")) return { ok: false, detail: "missing bearer token" };
  const token = header.slice("Bearer ".length).trim();
  if (token === "") return { ok: false, detail: "empty bearer token" };

  let decoded;
  try {
    decoded = decodeJwt(token);
  } catch (error) {
    return { ok: false, detail: `undecodable token (${describeError(error)})` };
  }
  if (decoded.header["alg"] !== "RS256") return { ok: false, detail: "unsupported alg" };
  const kid = typeof decoded.header["kid"] === "string" ? decoded.header["kid"] : "";
  if (kid === "") return { ok: false, detail: "token has no kid" };

  let keys: GoogleJwk[];
  try {
    keys = await fetchGoogleJwks(now);
  } catch (error) {
    return { ok: false, detail: `jwks unavailable (${describeError(error)})` };
  }
  const jwk = keys.find((candidate) => candidate.kid === kid);
  if (jwk === undefined) return { ok: false, detail: "kid not found in Google JWKS" };

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureValid = await verifyRs256Signature(cryptoKey, decoded);
  if (!signatureValid) return { ok: false, detail: "bad signature" };

  const claims = decoded.claims;
  const issuer = typeof claims["iss"] === "string" ? claims["iss"] : "";
  if (!GOOGLE_ISSUERS.includes(issuer)) return { ok: false, detail: "unexpected issuer" };
  const audience = typeof claims["aud"] === "string" ? claims["aud"] : "";
  if (input.audience === "" || audience !== input.audience) {
    return { ok: false, detail: "audience mismatch" };
  }
  const exp = typeof claims["exp"] === "number" ? claims["exp"] : 0;
  if (exp * 1000 <= now) return { ok: false, detail: "token expired" };

  return {
    ok: true,
    claims: {
      iss: issuer,
      aud: audience,
      exp,
      email: typeof claims["email"] === "string" ? claims["email"] : undefined,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** First 12 hex characters of a hash — enough to correlate logs, useless as a credential. */
export function shortHash(hash: string): string {
  return `sha256:${hash.slice(0, 12)}`;
}

/** One line from a Google error body, with any embedded token-looking string removed. */
export function summarizeGoogleError(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  if (trimmed === "") return "(empty body)";
  return trimmed.slice(0, 300);
}

/** Error message extraction that never stringifies an unknown object with secrets inside. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** base64url of a SHA-256 digest; kept beside the OAuth code that uses it for KV keys. */
export async function hashedKeyId(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export { sha256Hex };
