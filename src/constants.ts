/**
 * The wire contract, as literals.
 *
 * Every string in this file is duplicated from the Kotlin client on purpose — the Worker cannot
 * import Kotlin, and a typo here is a plan that sells but does not work. The Kotlin sources are
 * the spec:
 *
 *  * `composeApp/src/commonMain/kotlin/com/gestu/app/pro/ProCatalog.kt`      (headers, URLs, alias)
 *  * `composeApp/src/commonMain/kotlin/com/gestu/app/pro/ProKeyProvisioner.kt` (request/response)
 *  * `composeApp/src/commonMain/kotlin/com/gestu/app/pro/ProEntitlement.kt`  (ids, token limit)
 *  * `composeApp/src/commonMain/kotlin/com/gestu/app/pro/QuotaGate.kt`       (status vocabulary)
 */

/** Model alias the app asks for by id on the **Pro** route; rewritten to the configured upstream model. */
export const MANAGED_MODEL_ALIAS = "gestu-pro-flash";

/** Path the app posts to for a key; appended to `ACCOUNT_BASE_URL` by `HttpProKeyProvisioner`. */
export const PROVISION_PATH = "/api/provision-key";
/**
 * Path the app posts a device id to for the **Free** managed route's virtual key.
 *
 * Mirrors `ProCatalog.PROVISION_FREE_PATH`; body is `ProFreeTokenRequest`
 * (`{deviceId, packageName, appVersion}`). No Play purchase is involved: a Free key is
 * device-bound and metered against the Free per-device allowance.
 */
export const FREE_PROVISION_PATH = "/api/provision-free-token";
/**
 * Path the app posts an organisational licence to. Same answer shape as [PROVISION_PATH]: a
 * business licence and a Play subscription are two ways to the same managed key, so the client
 * reads one response type for both.
 */
export const PROVISION_LICENCE_PATH = "/api/provision-licence";
export const REVOKE_PATH = "/api/revoke-key";
export const STATUS_PATH = "/api/subscription-status";
export const RTDN_PATH = "/api/rtdn";
export const APPLE_ASN_PATH = "/api/apple-asn";
export const PAYMENT_WEBHOOK_PATH = "/api/webhook/payment";
export const HEALTH_PATH = "/health";

/** OpenAI-compatible surface the app's managed base URL (`https://api.gestu.ca/v1`) expects. */
export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
export const IMAGES_GENERATIONS_PATH = "/v1/images/generations";
export const MODELS_PATH = "/v1/models";
/**
 * Operator-only usage report (see `admin-usage.ts`).
 *
 * Deliberately outside `/v1` and `/api`: it is not part of the client contract, it is never
 * advertised by `/health`, and it answers only to `ADMIN_USAGE_SECRET`.
 */
export const ADMIN_USAGE_PATH = "/admin/usage";
/**
 * Operator-only PII-free funnel metrics report (see `funnel.ts`).
 *
 * Returns daily UTC aggregate counts for `trial_started`, `trial_cap_hit`, `pro_activated`, and
 * `day7_active`. Authenticated with the read-only `ADMIN_USAGE_SECRET`.
 */
export const ADMIN_FUNNEL_PATH = "/admin/funnel";
/**
 * Operator-only exemption management (see `admin-exempt.ts`).
 *
 * Like `/admin/usage` it sits outside `/v1` and `/api`: not part of the client contract, never
 * advertised by `/health`, and answered only to the operator master key.
 */
export const ADMIN_EXEMPT_PATH = "/admin/exempt";
/** Operator ban list: `POST /admin/block` to add or remove, `GET` to ask about one handle. */
export const ADMIN_BLOCK_PATH = "/admin/block";

/** Default upstream for Pro managed image generation (`gestu-image-gen` Worker). */
export const DEFAULT_IMAGE_GEN_BASE_URL = "https://images.gestu.ca";
/** Monthly Fair Use image generation cap per Pro account. */
export const PRO_MONTHLY_IMAGE_LIMIT = 200;
/** Per-minute image generation burst limit per Pro account. */
export const PRO_IMAGE_RATE_LIMIT_PER_MINUTE = 10;

/**
 * The Free managed route's public model id, exactly as `ProCatalog.FREE_MANAGED_MODEL_ID`
 * declares it. The app asks for this id, so the proxy must accept it verbatim.
 *
 * It is a stable *label* the shipped client is compiled against, not the upstream model: both
 * managed routes now reach the same DeepSeek Direct upstream, and this string is rewritten to the
 * configured upstream id on the way out and back to this label on the way in. The provider and its
 * model id never appear in a request the client sends, or in a response it reads.
 */
export const FREE_MANAGED_MODEL_ID = "gestu-free-flash";
/** Same id as [FREE_MANAGED_MODEL_ID]; kept as a name so older call sites read the same. */
export const FREE_MANAGED_MODEL_ALIAS = FREE_MANAGED_MODEL_ID;
/**
 * The Free id app versions up to 2.5.11 send. Accepted as input and echoed back to those clients
 * only; never listed by `/v1/models` and never shown by current apps.
 */
export const LEGACY_FREE_MANAGED_MODEL_ID = "gemini-3.5-flash-lite";

/** Upstream base URL used by the Free route (DeepSeek Direct, OpenAI-compatible). */
export const DEFAULT_FREE_UPSTREAM_BASE_URL = "https://api.deepseek.com/v1";
/**
 * Upstream model id the Free route forwards. Internal only: the public ids above are what the app
 * sends and what every response carries, and a provider id must never reach a client.
 */
export const DEFAULT_FREE_UPSTREAM_MODEL_ID = "deepseek-flash";

/** Default Pro upstream, used when neither `UPSTREAM_BASE_URL` nor legacy aliases are set. */
export const DEFAULT_PRO_UPSTREAM_BASE_URL = "https://api.deepseek.com/v1";
/** Default Pro upstream model, used when neither `UPSTREAM_MODEL_ID` nor legacy aliases are set. */
export const DEFAULT_PRO_UPSTREAM_MODEL_ID = "deepseek-flash";


/** `ProCatalog.SUBSCRIPTION_HEADER` — accepted as an alternative to `Authorization: Bearer`. */
export const SUBSCRIPTION_HEADER = "X-Gestu-Subscription";

/**
 * `ProCatalog.HEADER_QUOTA_*` — the app's local quota mirror is corrected from these. They are
 * set on every proxied response (streamed or not) and on the 429 that ends the month.
 */
export const HEADER_QUOTA_USED = "X-Gestu-Quota-Used";
export const HEADER_QUOTA_LIMIT = "X-Gestu-Quota-Limit";
export const HEADER_QUOTA_PERIOD = "X-Gestu-Quota-Period";
export const HEADER_QUOTA_RENEWS_AT = "X-Gestu-Quota-Renews-At";
export const HEADER_QUOTA_UNIT = "X-Gestu-Quota-Unit";
export const HEADER_QUOTA_MODE = "X-Gestu-Quota-Mode";
export const HEADER_QUOTA_INPUT_USED = "X-Gestu-Quota-Input-Used";
export const HEADER_QUOTA_INPUT_LIMIT = "X-Gestu-Quota-Input-Limit";
export const HEADER_QUOTA_OUTPUT_USED = "X-Gestu-Quota-Output-Used";
export const HEADER_QUOTA_OUTPUT_LIMIT = "X-Gestu-Quota-Output-Limit";

export const QUOTA_UNIT_PPM = "ppm";
export const QUOTA_UNIT_TOKENS = "tokens";

/** Maximum request body size accepted by POST /v1/chat/completions (6 MiB, accommodates 1M context window). */
export const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;
/** Maximum completion tokens allowed in normal mode on Pro (384K). */
export const MAX_COMPLETION_TOKENS = 384_000;
/** Maximum completion tokens allowed on Free tier. */
export const FREE_MAX_COMPLETION_TOKENS = 64_000;
/** Maximum completion tokens allowed in reduced (degraded) mode after soft cap is reached. */
export const REDUCED_MODE_MAX_TOKENS = 4_096;

/** `ProDenialReason` — the only refusal vocabulary the client understands. */
export const DENIAL = {
  REVOKED: "revoked",
  EXPIRED: "expired",
  NOT_VERIFIED: "not_verified",
  DEVICE_LIMIT: "device_limit",
  INVALID_TOKEN: "invalid_token",
  RATE_LIMITED: "rate_limited",
} as const;

export type DenialReason = (typeof DENIAL)[keyof typeof DENIAL];

/** `SubscriptionStatus.id`-equivalent strings the `/api/subscription-status` answer reports. */
export const STATUS = {
  NONE: "none",
  ACTIVE: "active",
  GRACE: "grace",
  ON_HOLD: "on_hold",
  CANCELED: "canceled",
  EXPIRED: "expired",
  REVOKED: "revoked",
} as const;

export type SubscriptionStatusId = (typeof STATUS)[keyof typeof STATUS];

/** `ProPlan.id`. Gestu sells exactly two tiers: `free` and `pro`. */
export const PLAN_FREE = "free";
export const PLAN_PRO = "pro";

export type PlanTier = "free" | "pro";

export const PRODUCT_ID_FREE = "gestu_free";
export const PRODUCT_ID_PRO = "gestu_pro_monthly";

/** Default Free trial duration per device: 7 days (paired with the $0.50 per-user cost cap). */
export const FREE_TRIAL_WINDOW_DAYS = 7;
export const FREE_TRIAL_WINDOW_MS = FREE_TRIAL_WINDOW_DAYS * 86_400_000;

/** Per-tier monthly output billing caps and input cost-control caps, and per-request budgets. */
export const FREE_MONTHLY_OUTPUT_TOKENS = 200_000;
/**
 * Free route's monthly *input* safety cap. Primary metering on DO-backed Free keys is the
 * US$0.50 per-user trial cost budget (`DEFAULT_FREE_MONTHLY_CAP_MICRO_USD`), so the token caps sit
 * above what US$0.50 buys at cached DeepSeek rates and are never shown as a fixed number to users.
 */
export const FREE_MONTHLY_INPUT_TOKENS = 15_000_000;
/** Free per-request window: 200,000 input + 64,000 output. The per-user US$0.50 budget still bounds spend. */
export const FREE_MAX_REQUEST_TOKENS = 264_000;
export const FREE_MAX_INPUT_TOKENS = 200_000;

export const PRO_MONTHLY_OUTPUT_TOKENS = 1_500_000;
export const PRO_MONTHLY_INPUT_TOKENS = 100_000_000;

/**
 * 1,000,000 (1M) total context window ceiling and up to 384,000 (384K) max output tokens per request on Pro.
 */
export const PAID_MAX_INPUT_TOKENS = 1_000_000;
export const PAID_MAX_REQUEST_TOKENS = 1_000_000;

/** Combined-token ceiling for one Free key per UTC month (output cap + input cost control). */
export const FREE_MONTHLY_TOTAL_TOKENS = FREE_MONTHLY_OUTPUT_TOKENS + FREE_MONTHLY_INPUT_TOKENS;

/**
 * Resolves a Play product id, licence plan id or `ProPlan` id to the server-enforced plan tier.
 * Unknown or empty identifiers fail closed to `"free"`.
 *
 * Exactly two tiers exist. Anything naming `pro` (the Play product, a business licence, a
 * `gestu_pro_licence` seat) is Pro; everything else is Free.
 */
export function tierForProductId(productId: string | undefined | null): PlanTier {
  if (typeof productId !== "string") return PLAN_FREE;
  const normalized = productId.trim().toLowerCase();
  if (normalized === "" || normalized === PRODUCT_ID_FREE || normalized === PLAN_FREE) {
    return PLAN_FREE;
  }
  if (
    normalized === PRODUCT_ID_PRO ||
    normalized === PRODUCT_ID_BUSINESS ||
    normalized === "gestu_pro_licence" ||
    normalized === PLAN_PRO
  ) {
    return PLAN_PRO;
  }
  const segments = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return segments.includes(PLAN_PRO) ? PLAN_PRO : PLAN_FREE;
}

/** Virtual key shape: `gsk_` (or legacy `msk_`) + base64url(32 random bytes) = 4 + 43 characters. */
export const VIRTUAL_KEY_PREFIX = "gsk_";
export const VIRTUAL_KEY_PREFIX_LEGACY = "msk_";
export const VIRTUAL_KEY_BYTES = 32;

/**
 * Licence token shape: `GESTU1.` + base64url(claims) + `.` + base64url(ES256 signature).
 *
 * The version is in the prefix so a future format can be recognised — and refused — before a
 * parser has to understand any of it. A user pasting a licence has no way to tell one version from
 * another, so the failure has to be the server's to explain.
 */
export const LICENCE_PREFIX = "GESTU1.";

/**
 * Product id recorded for a key minted from a licence rather than from Play.
 *
 * Deliberately *not* `gestu_pro_monthly`: the key record's product id is what an operator reads
 * when reconciling, and a business licence that looked like a Play subscription in the records
 * would make two different revenue paths indistinguishable during support.
 */
export const PRODUCT_ID_BUSINESS = "gestu_business";

/**
 * Public base URL used for `proxyBaseUrl` in the provision answer. Overridable by
 * `GESTU_PUBLIC_BASE_URL`; the literal matches `ProCatalog.ACCOUNT_BASE_URL` (`api.gestu.ca`)
 * and serves both managed tiers.
 */
export const DEFAULT_PUBLIC_BASE_URL = "https://api.gestu.ca";

/** `ProCatalog.MANAGED_PROXY_BASE_URL` — what the app was compiled with. */
export const DEFAULT_PROXY_BASE_URL = "https://api.gestu.ca/v1";

/**
 * The Pro plan's combined monthly token ceiling — output billing cap plus input cost-control cap.
 *
 * ## What this number is
 *
 * The locked Pro allowance is **1,500,000 output tokens/mo AND 100,000,000 input tokens/mo**.
 * Those two caps are enforced separately (`checkTierTokenCaps`), and this combined ceiling is the
 * KV counter's belt-and-braces backstop: `used` here is prompt + completion tokens for the UTC
 * month, so it can never exceed what the two split caps allow.
 *
 * ## Why it is a constant *and* an env var
 *
 * `GESTU_MONTHLY_TOKEN_LIMIT` overrides this at deploy time, so the backstop can move without an
 * app release. The split caps are the product promise and live in code; this is the operational
 * seam the fair-use tests pin.
 *
 * ## The exposure this number carries
 *
 * Raising it raises the worst case per subscriber linearly, and the `429` this produces is the only
 * thing between a leaked key and the operator's bill. A change here is a pricing decision.
 */
export const DEFAULT_MONTHLY_TOKEN_LIMIT = PRO_MONTHLY_OUTPUT_TOKENS + PRO_MONTHLY_INPUT_TOKENS;

/**
 * The monthly combined-token ceiling for a **business licence** — the ceiling on a key minted from
 * an organisation's licence rather than from a Play subscription.
 *
 * A licence is *one* key shared by every device in the company, so it carries its own allowance:
 * ten times the Pro split caps (`monthlyOutputTokenLimitFor` / `monthlyInputTokenLimitFor` return
 * 10× for a business product id), which is far above what a company of ordinary users reaches and
 * still a predictable worst case per licence.
 *
 * `GESTU_BUSINESS_MONTHLY_TOKEN_LIMIT` overrides it at deploy time.
 */
export const DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT =
  (PRO_MONTHLY_OUTPUT_TOKENS + PRO_MONTHLY_INPUT_TOKENS) * 10;

/** `DEVICE_LIMIT` default when `GESTU_DEVICE_LIMIT` is unset. */
export const DEFAULT_DEVICE_LIMIT = 2;

/**
 * Upper bound on how many purchase tokens one provision request may carry. The app sends "every
 * token the store currently holds"; a hostile client could send thousands to burn service-account
 * quota, so the list is truncated (never rejected — a real multi-token subscription still works).
 */
export const MAX_PURCHASE_TOKENS = 12;

// ---------------------------------------------------------------------------------------------
// Free managed route — anti-abuse limits
// ---------------------------------------------------------------------------------------------
//
// The Free route mints a device-bound key with no purchase behind it, so the only thing between a
// script and the operator's bill is (a) the per-device monthly output cap and (b) these limits.
// They are deliberately two windows, because they stop two different attacks:
//
//  * the **short window** stops a scripted client burning a whole month's allowance in a minute;
//  * the **long window** stops a script cycling device ids / clearing app data to mint a fresh
//    200,000-token allowance each time.
//
// Both are keyed by device id *and* `CF-Connecting-IP`: device id alone is forgeable; IP alone
// breaks a shared household/NAT, so the pair is the unit. A missing IP fails closed at the caller.

/** How many `POST /api/provision-free-token` calls one IP+device may make per hour. */
export const FREE_PROVISION_RATE_LIMIT = 12;
/** How many `POST /api/provision-free-token` calls a single IP (across all deviceIds) may make per hour. */
export const FREE_IP_PROVISION_RATE_LIMIT = 36;
export const FREE_PROVISION_RATE_WINDOW_MS = 60 * 60 * 1000;

/** How many Free inference requests one IP+device may make per minute. */
export const FREE_CHAT_RATE_LIMIT = 100;
/**
 * How many Free inference requests a single IP (across all deviceIds) may make per minute.
 *
 * Twice the per-device ceiling, so one client can always reach its own allowance. A lower IP cap
 * binds first and quietly becomes the real per-device limit.
 */
export const FREE_IP_CHAT_RATE_LIMIT = 200;
/** The short-window length for Free inference: one minute, matching `FREE_RATE_LIMITER`. */
export const FREE_CHAT_RATE_WINDOW_MS = 60 * 1000;

/** How many Free inference requests one IP+device may make per UTC day. */
export const FREE_CHAT_DAILY_RATE_LIMIT = 100;
/** How many Free inference requests a single IP (across all deviceIds) may make per UTC day. */
export const FREE_IP_CHAT_DAILY_RATE_LIMIT = 300;
export const FREE_CHAT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Datacenter / cloud bot-farm strict provisioning cap per IP per hour on Free tier. */
export const FREE_DATACENTER_IP_PROVISION_RATE_LIMIT = 2;

