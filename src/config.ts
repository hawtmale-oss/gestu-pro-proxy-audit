/**
 * Bindings and configuration.
 *
 * Two classes of configuration, deliberately separated:
 *
 *  * **vars** (`[vars]` in wrangler.toml) — public, reviewable in the repo. Parsed here.
 *  * **secrets** (`wrangler secret put`) — never logged, never returned. Read here, used once,
 *    and never echoed into a response body or a log line.
 *
 * Every parser fails *closed*: a missing or unparseable value yields the safe answer (feature
 * off / deny) rather than a permissive default, and says so on one log line.
 */

import {
  DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT,
  DEFAULT_DEVICE_LIMIT,
  DEFAULT_FREE_UPSTREAM_BASE_URL,
  DEFAULT_FREE_UPSTREAM_MODEL_ID,
  DEFAULT_IMAGE_GEN_BASE_URL,
  DEFAULT_MONTHLY_TOKEN_LIMIT,
  DEFAULT_PRO_UPSTREAM_BASE_URL,
  DEFAULT_PRO_UPSTREAM_MODEL_ID,
  DEFAULT_PUBLIC_BASE_URL,
  FREE_MONTHLY_OUTPUT_TOKENS,
} from "./constants";
import type { PriceTable } from "./cost";
import { DEFAULT_SOFT_CAP_MICRO_USD, parsePriceTable } from "./cost";

/**
 * The Cloudflare `ratelimit` binding surface this Worker uses, typed structurally.
 *
 * The binding is optional: deployments without it fall back to a KV window counter (see
 * `free.ts`), which is weaker but still fail-closed. Typing it here rather than relying on the
 * ambient global keeps the test fake and the runtime binding the same shape.
 */
export interface FreeRateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The `analytics_engine` binding surface, typed structurally.
 *
 * Optional like the rate limiter: a deployment without the binding simply skips the data point,
 * so turning the dataset off never breaks a completion. `writeDataPoint` is synchronous and
 * fire-and-forget by design — metering must not wait on, or fail because of, telemetry.
 */
export interface AnalyticsEngineBinding {
  writeDataPoint(event: {
    blobs?: (string | null)[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

export interface Env {
  /** KV namespace: virtual key records, purchase index, quota counters, Free device index. */
  PRO_KV: KVNamespace;
  /** SQLite-backed Durable Object for per-licence state, seats, concurrency, and µUSD spend. */
  LICENCE_METER?: DurableObjectNamespace;
  /**
   * Optional Cloudflare `ratelimit` binding for the Free route's short window. When present, it is
   * the authoritative per-minute throttle; the KV counter is still used for the long window.
   */
  FREE_RATE_LIMITER?: FreeRateLimiterBinding;
  /**
   * Optional per-IP short window for the Free route. Separate from [FREE_RATE_LIMITER] because a
   * binding carries exactly one limit, and the IP ceiling is higher than the per-device one.
   */
  FREE_IP_RATE_LIMITER?: FreeRateLimiterBinding;
  /**
   * Per-(scope, identity) day-counter object. When bound, the day windows stop writing a KV
   * counter per request; KV remains the fallback when it is absent.
   */
  ACCESS_METER?: DurableObjectNamespace;
  /**
   * Optional Analytics Engine dataset for per-request usage rows. Absent by default; when bound,
   * every metered completion writes one data point (see `proxy.ts`).
   */
  USAGE_ANALYTICS?: AnalyticsEngineBinding;
  /**
   * Optional Cloudflare D1 database for the 4 PII-free daily funnel counters
   * (`trial_started`, `trial_cap_hit`, `pro_activated`, `day7_active`). See `src/funnel.ts`.
   */
  FUNNEL_DB?: D1Database;

  // ---- vars ---------------------------------------------------------------------------------
  /**
   * Emergency-only global daily Free spend guardrail in USD (default `500` = $500/day).
   * Normal trial users are governed by per-user trial limits (7-day window or $0.50 cap);
   * set to `"0"` or `"off"` to disable the emergency guardrail explicitly.
   */
  GESTU_FREE_EMERGENCY_DAILY_CAP_USD?: string;
  /** Legacy alias for `GESTU_FREE_EMERGENCY_DAILY_CAP_USD`. */
  GESTU_FREE_GLOBAL_DAILY_CAP_USD?: string;
  /** Free trial window length in days per device (default `7`). */
  GESTU_FREE_TRIAL_DAYS?: string;
  GESTU_PRODUCT_ID?: string;
  GESTU_BASE_PLAN_ID?: string;
  GESTU_MONTHLY_TOKEN_LIMIT?: string;
  /** Monthly ceiling for a business licence's key; see `DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT`. */
  GESTU_BUSINESS_MONTHLY_TOKEN_LIMIT?: string;
  /** Monthly soft cap in micro-USD for licence-backed Pro keys (default 10,000,000 = $10.00). */
  GESTU_MONTHLY_CAP_MICRO_USD?: string;
  /** JSON price table for prompt cache hit/miss and completion rates in µUSD per 1M tokens. */
  GESTU_PRICE_TABLE?: string;
  GESTU_ALLOWED_PACKAGE_NAMES?: string;
  /**
   * Pro upstream OpenAI-compatible base URL. Defaults to `https://api.deepseek.com/v1`; overridable
   * for a different managed host without code changes. The legacy `DEEPSEEK_BASE_URL` /
   * `DEEPSEEK_CHAT_MODEL` aliases are read only when the `UPSTREAM_*` pair is unset. Internal
   * configuration only — the provider name must never reach a customer-facing response.
   */
  UPSTREAM_BASE_URL?: string;
  /** Pro upstream model id (e.g. `deepseek-flash`). */
  UPSTREAM_MODEL_ID?: string;
  /** Optional secondary Pro upstream base URL. */
  UPSTREAM_FALLBACK_BASE_URL?: string;
  /** Optional secondary Pro upstream model id. */
  UPSTREAM_FALLBACK_MODEL_ID?: string;
  /** Legacy aliases for `UPSTREAM_BASE_URL` / `UPSTREAM_MODEL_ID`. */
  DEEPSEEK_BASE_URL?: string;
  DEEPSEEK_CHAT_MODEL?: string;
  /**
   * Free managed route upstream base URL: the same DeepSeek Direct OpenAI-compatible API the Pro
   * route uses (`https://api.deepseek.com/v1`). Only the credential and the model id differ.
   */
  FREE_UPSTREAM_BASE_URL?: string;
  /** Free managed route upstream model id (`deepseek-flash`); never visible to a client. */
  FREE_UPSTREAM_MODEL_ID?: string;
  GESTU_EXPOSED_MODELS?: string;
  GESTU_DEVICE_LIMIT?: string;
  GESTU_PUBLIC_BASE_URL?: string;
  GESTU_ALLOWED_ORIGINS?: string;
  GOOGLE_OAUTH_TOKEN_URL?: string;
  GOOGLE_PLAY_API_BASE?: string;
  RTDN_AUDIENCE?: string;
  IMAGE_GEN_BASE_URL?: string;

  // ---- secrets ------------------------------------------------------------------------------
  /**
   * Operator exemptions: `sha256(deviceId)` values (lowercase hex, comma-separated) whose device
   * bypasses every managed limit — Free device/rate/allowance caps and Pro seats and allowances.
   * Set with `wrangler secret put`, never in `[vars]`: the list is deployment-private. See
   * `src/exempt.ts`.
   */
  GESTU_UNLIMITED_DEVICE_HASHES?: string;
  /** Operator exemptions by `CF-Connecting-IP`, for testing before a device id can be read. */
  GESTU_UNLIMITED_IPS?: string;
  /**
   * Operator master key: a static bearer credential that authenticates with no key record and no
   * limits. Paste it into any OpenAI-compatible client as the API key (`gestu-pro-flash` model,
   * `https://api.gestu.ca/v1` base). Set with `wrangler secret put`, never `[vars]`; leaving it
   * unset removes the credential entirely rather than leaving a weak one behind.
   */
  GESTU_UNLIMITED_KEY?: string;
  /**
   * Bearer secret for the operator `GET /admin/usage` report.
   *
   * Kept separate from `entitlement-service`'s `ADMIN_SECRET` on purpose: the reporting secret
   * can only read counters, so a leak does not also confer the power to issue or revoke licences.
   * When unset the endpoint answers 503 rather than exposing totals.
   */
  ADMIN_USAGE_SECRET?: string;
  /** Server-to-server bearer secret for the Pro `gestu-image-gen` Worker. */
  IMAGE_GEN_API_KEY?: string;
  /**
   * Pro upstream API key / bearer credential. Subscribers never see this credential;
   * their virtual key is only ever accepted by this Worker.
   */
  UPSTREAM_API_KEY?: string;
  /** Optional fallback Pro upstream API key. */
  UPSTREAM_FALLBACK_API_KEY?: string;
  /** Meta / Model API key aliases (`META_API_KEY` / `MODEL_API_KEY`), accepted for older deployments. */
  META_API_KEY?: string;
  MODEL_API_KEY?: string;
  /** Legacy alias for UPSTREAM_API_KEY. */
  DEEPSEEK_API_KEY?: string;
  /**
   * Free managed route upstream key for the DeepSeek Direct API. Preferred over the legacy
   * `GEMINI_FREE_API_KEY` name; falls back to the shared `DEEPSEEK_API_KEY` when neither is set.
   * Held only here — the app never receives a provider credential.
   */
  DEEPSEEK_FREE_API_KEY?: string;
  /** Legacy Free-route secret name (Google Generative Language key); still honoured. */
  GEMINI_FREE_API_KEY?: string;
  /** Service-account `client_email` with Play Console API access. */
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  /** Service-account private key, PKCS#8 PEM (the `private_key` field of the JSON key file). */
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  /**
   * ES256 (EC P-256, SPKI PEM) public key that organisational licence tokens are signed with.
   * Can be a single PEM string or a JSON mapping of { [kid: string]: string }.
   */
  GESTU_LICENCE_PUBLIC_KEY?: string;
  /** JSON map of { [kid: string]: string } for multi-key rotation. */
  GESTU_LICENCE_PUBLIC_KEYS?: string;
  /** Current active kid to attach to newly minted licences. */
  GESTU_LICENCE_CURRENT_KID?: string;
}

/** Configuration that originates in `[vars]`, with sensible defaults applied. */
export interface ProxyConfig {
  productId: string;
  basePlanId: string;
  monthlyTokenLimit: number;
  /** The Free route's per-device fallback monthly output ceiling (when DO cost metering is absent). */
  freeMonthlyOutputTokenLimit: number;
  /**
   * Monthly ceiling for a business licence's key. Separate from [monthlyTokenLimit] because one
   * licence is shared by a whole company — see `DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT`.
   */
  businessMonthlyTokenLimit: number;
  monthlyCapMicroUsd?: number;
  priceTable?: PriceTable;
  allowedPackageNames: string[];
  /** Pro upstream OpenAI-compatible base URL (no trailing slash). */
  proUpstreamBaseUrl: string;
  /** Pro upstream model id the `gestu-pro-flash` alias is rewritten to. */
  proUpstreamModelId: string;
  /** Free managed route upstream base URL (no trailing slash). */
  freeUpstreamBaseUrl: string;
  /** Free managed route upstream model id. */
  freeUpstreamModelId: string;
  upstreamFallbackBaseUrl?: string;
  upstreamFallbackModelId?: string;
  exposedModels: string[];
  deviceLimit: number;
  publicBaseUrl: string;
  proxyBaseUrl: string;
  allowedOrigins: string[];
  googleOAuthTokenUrl: string;
  googlePlayApiBase: string;
  rtdnAudience: string;
  imageGenBaseUrl?: string;
}

/** Service-account credentials. `null` means "not configured", which must fail closed. */
export interface ServiceAccount {
  clientEmail: string;
  /** PKCS#8 PEM, exactly as Google's JSON key file carries it. */
  privateKeyPem: string;
}

/**
 * Reads a var as a trimmed string.
 *
 * `Env` is a plain interface without an index signature (deliberately: a typo in a var name should
 * not type-check), so the readers take the one shape they need rather than the whole binding set.
 */
function readString(env: Env, name: keyof Env & string): string {
  const raw = env[name];
  return typeof raw === "string" ? raw.trim() : "";
}

function readInt(env: Env, name: keyof Env & string, fallback: number): number {
  const raw = readString(env, name);
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`config: ${name} is not a positive number; falling back to ${fallback}`);
    return fallback;
  }
  return Math.floor(parsed);
}

function readList(env: Env, name: keyof Env & string): string[] {
  return readString(env, name)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Reads the public configuration.
 *
 * `UPSTREAM_BASE_URL` and `UPSTREAM_MODEL_ID` take precedence over the legacy `DEEPSEEK_*` names
 * so the Pro route can be pointed at a different managed host without code changes. The Free
 * route has its own `FREE_UPSTREAM_*` pair because it speaks to a different provider.
 */
export function readConfig(env: Env): ProxyConfig {
  const publicBaseUrl = readString(env, "GESTU_PUBLIC_BASE_URL") || DEFAULT_PUBLIC_BASE_URL;
  const allowedPackageNames = readList(env, "GESTU_ALLOWED_PACKAGE_NAMES");
  if (allowedPackageNames.length === 0) {
    console.error(
      "config: GESTU_ALLOWED_PACKAGE_NAMES is empty; every provision request will be refused (fail closed)",
    );
  }
  const upstreamBaseUrl =
    readString(env, "UPSTREAM_BASE_URL") ||
    readString(env, "DEEPSEEK_BASE_URL") ||
    DEFAULT_PRO_UPSTREAM_BASE_URL;
  const upstreamModelId =
    readString(env, "UPSTREAM_MODEL_ID") ||
    readString(env, "DEEPSEEK_CHAT_MODEL") ||
    DEFAULT_PRO_UPSTREAM_MODEL_ID;
  const fallbackBaseUrl = readString(env, "UPSTREAM_FALLBACK_BASE_URL").replace(/\/+$/, "");
  const fallbackModelId = readString(env, "UPSTREAM_FALLBACK_MODEL_ID") || upstreamModelId;
  const freeUpstreamBaseUrl =
    readString(env, "FREE_UPSTREAM_BASE_URL") || DEFAULT_FREE_UPSTREAM_BASE_URL;
  const freeUpstreamModelId =
    readString(env, "FREE_UPSTREAM_MODEL_ID") || DEFAULT_FREE_UPSTREAM_MODEL_ID;

  return {
    productId: readString(env, "GESTU_PRODUCT_ID") || "gestu_pro_monthly",
    basePlanId: readString(env, "GESTU_BASE_PLAN_ID") || "gestu-pro-monthly",
    monthlyTokenLimit: readInt(env, "GESTU_MONTHLY_TOKEN_LIMIT", DEFAULT_MONTHLY_TOKEN_LIMIT),
    freeMonthlyOutputTokenLimit: FREE_MONTHLY_OUTPUT_TOKENS,
    businessMonthlyTokenLimit: readInt(
      env,
      "GESTU_BUSINESS_MONTHLY_TOKEN_LIMIT",
      DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT,
    ),
    monthlyCapMicroUsd: readInt(env, "GESTU_MONTHLY_CAP_MICRO_USD", DEFAULT_SOFT_CAP_MICRO_USD),
    priceTable: parsePriceTable(readString(env, "GESTU_PRICE_TABLE")),
    allowedPackageNames,
    proUpstreamBaseUrl: upstreamBaseUrl.replace(/\/+$/, ""),
    proUpstreamModelId: upstreamModelId,
    freeUpstreamBaseUrl: freeUpstreamBaseUrl.replace(/\/+$/, ""),
    freeUpstreamModelId,
    upstreamFallbackBaseUrl: fallbackBaseUrl,
    upstreamFallbackModelId: fallbackModelId,
    exposedModels: readList(env, "GESTU_EXPOSED_MODELS"),
    deviceLimit: readInt(env, "GESTU_DEVICE_LIMIT", DEFAULT_DEVICE_LIMIT),
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
    proxyBaseUrl: `${publicBaseUrl.replace(/\/+$/, "")}/v1`,
    allowedOrigins: readList(env, "GESTU_ALLOWED_ORIGINS"),
    googleOAuthTokenUrl: readString(env, "GOOGLE_OAUTH_TOKEN_URL") || "https://oauth2.googleapis.com/token",
    googlePlayApiBase:
      (readString(env, "GOOGLE_PLAY_API_BASE") || "https://androidpublisher.googleapis.com/androidpublisher/v3").replace(
        /\/+$/,
        "",
      ),
    rtdnAudience: readString(env, "RTDN_AUDIENCE"),
    imageGenBaseUrl: (readString(env, "IMAGE_GEN_BASE_URL") || DEFAULT_IMAGE_GEN_BASE_URL).replace(/\/+$/, ""),
  };
}

/**
 * Reads the Play service account, or `null` when it is not fully configured.
 *
 * This is the security property of the whole design: **with no service account the Worker cannot
 * verify a purchase, so it must deny every provision request** (`not_verified`) rather than
 * believe the client's claim about a receipt. Callers get `null` and are expected to fail closed;
 * `requireServiceAccount` in `google.ts` is the loud wrapper.
 *
 * @param options.quiet suppresses the "not configured" error. `GET /health` calls this to *report*
 *   the state, and a licence-only deployment — where the absence is correct rather than a fault —
 *   would otherwise write an error line on every health check, burying the real ones. The loud
 *   default is kept for the provisioning paths, where the absence genuinely is a misconfiguration.
 */
export function readServiceAccount(env: Env, options: { quiet?: boolean } = {}): ServiceAccount | null {
  const clientEmail = readString(env, "GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyPem = readString(env, "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  if (clientEmail === "" || privateKeyPem === "") {
    if (options.quiet !== true) {
      console.error(
        "config: GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are not both set — " +
          "purchase verification is impossible and every provision request will be denied (fail closed)",
      );
    }
    return null;
  }
  return { clientEmail, privateKeyPem };
}

/** Returns the configured Pro upstream API key (`UPSTREAM_API_KEY`, `META_API_KEY`, `MODEL_API_KEY`, or legacy `DEEPSEEK_API_KEY`). */
export function readUpstreamApiKey(env: Env): string {
  return (
    readString(env, "UPSTREAM_API_KEY") ||
    readString(env, "META_API_KEY") ||
    readString(env, "MODEL_API_KEY") ||
    readString(env, "DEEPSEEK_API_KEY")
  );
}

/** Returns the configured fallback upstream API key, or falls back to the primary key. */
export function readUpstreamFallbackApiKey(env: Env): string {
  return readString(env, "UPSTREAM_FALLBACK_API_KEY") || readUpstreamApiKey(env);
}

/** True when the Pro upstream credential exists. Without it the Pro proxy cannot forward anything. */
export function hasProUpstreamKey(env: Env): boolean {
  return readUpstreamApiKey(env) !== "";
}

/**
 * The Free managed route's upstream credential.
 *
 * Precedence: `DEEPSEEK_FREE_API_KEY` (a dedicated Free key) → legacy `GEMINI_FREE_API_KEY` →
 * the shared `DEEPSEEK_API_KEY` the Pro route also uses. One direct-API key can therefore serve
 * both managed tiers without duplicating the secret per route, and neither name is ever returned
 * to a client.
 */
export function readFreeUpstreamApiKey(env: Env): string {
  return (
    readString(env, "DEEPSEEK_FREE_API_KEY") ||
    readString(env, "GEMINI_FREE_API_KEY") ||
    readString(env, "DEEPSEEK_API_KEY")
  );
}

/** True when the Free managed route credential exists. */
export function hasFreeUpstreamKey(env: Env): boolean {
  return readFreeUpstreamApiKey(env) !== "";
}

/** Server-to-server secret used to authenticate Pro image requests to `gestu-image-gen`. */
export function readImageGenApiKey(env: Env): string {
  return readString(env, "IMAGE_GEN_API_KEY");
}

/** True when the Pro image-gen secret is configured. */
export function hasImageGenKey(env: Env): boolean {
  return readImageGenApiKey(env) !== "";
}

/** Returns the optional Cloudflare `ratelimit` binding for the Free route, if bound. */
export function readFreeRateLimiter(env: Env): FreeRateLimiterBinding | undefined {
  return env.FREE_RATE_LIMITER;
}

/** Per-IP short window for the Free route, if bound. */
export function readFreeIpRateLimiter(env: Env): FreeRateLimiterBinding | undefined {
  return env.FREE_IP_RATE_LIMITER;
}

/** The day-counter Durable Object, if bound. Absent means the KV fallback is used. */
export function readAccessMeter(env: Env): DurableObjectNamespace | undefined {
  return env.ACCESS_METER;
}

/**
 * Reads the organisational-licence public key, or `""` when it is not configured.
 * Supports passing an optional [kid] to select the key from a key map.
 */
export function readLicencePublicKey(env: Env, kid?: string): string {
  if (kid && kid.trim() !== "") {
    const multi = readString(env, "GESTU_LICENCE_PUBLIC_KEYS");
    if (multi !== "") {
      try {
        const parsed = JSON.parse(multi) as Record<string, string>;
        if (parsed[kid]) return parsed[kid];
      } catch {
        // malformed json
      }
    }
    const single = readString(env, "GESTU_LICENCE_PUBLIC_KEY");
    if (single.startsWith("{")) {
      try {
        const parsed = JSON.parse(single) as Record<string, string>;
        if (parsed[kid]) return parsed[kid];
      } catch {
        // malformed json
      }
    }
    if (single !== "") return single;
  }
  const direct = readString(env, "GESTU_LICENCE_PUBLIC_KEY");
  if (direct !== "") return direct;
  return readString(env, "GESTU_LICENCE_PUBLIC_KEYS");
}
