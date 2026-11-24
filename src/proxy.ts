/**
 * The metered chat proxy: `POST /v1/chat/completions` and `GET /v1/models`.
 *
 * One OpenAI-compatible surface serves **both** managed tiers. Which upstream a request reaches is
 * decided by the virtual key's plan tier, and nothing about the provider (name, URL, key, raw error
 * body) ever reaches the client:
 *
 *  * **Free** keys (`productId = gestu_free`) forward to the Free managed route
 *    (`FREE_UPSTREAM_BASE_URL`, the same DeepSeek Direct API, default `https://api.deepseek.com/v1`)
 *    and are bounded by the per-device 200,000-output-token month plus IP+device rate limits;
 *  * **Pro** keys forward to the Pro managed route (`UPSTREAM_BASE_URL`, the same DeepSeek Direct
 *    API, default `https://api.deepseek.com/v1` / `deepseek-flash`) within 1,500,000 output /
 *    100,000,000 input tokens per month and strictly below 200,000 input tokens per request.
 *
 * Both tiers are a reasoning surface: high reasoning is on in normal mode and is forced off only in
 * reduced mode, after the monthly cost cap.
 *
 * The shape of the handler follows from three facts about the client:
 *
 *  1. **It streams.** The managed route must behave exactly like an OpenAI-compatible endpoint, so
 *     the response body is forwarded byte-for-byte (SSE framing included, `[DONE]` included) as it
 *     arrives. Nothing is buffered; time-to-first-token is unchanged.
 *  2. **Its budget is enforced here.** The check happens *before* the upstream call, so the month
 *     cannot be overshot by one more request, and the answer is `429` with the quota headers —
 *     the single signal the app's out-of-credit flow keys off. The outbound `max_tokens` is clamped
 *     to the tier ceiling **before** that estimate, so a hostile huge value can neither fail the
 *     budget check nor slip an unbounded generation past it.
 *  3. **Usage arrives last.** The upstream reports `usage` on the final chunk, so the counter is
 *     updated as the last bytes go past. The headers on that same response therefore describe the
 *     state *before* it; the request's own tokens are added immediately afterwards.
 */

import {
  DEFAULT_IMAGE_GEN_BASE_URL,
  DENIAL,
  FREE_MANAGED_MODEL_ALIAS,
  FREE_CHAT_RATE_WINDOW_MS,
  FREE_MANAGED_MODEL_ID,
  LEGACY_FREE_MANAGED_MODEL_ID,
  MANAGED_MODEL_ALIAS,
  MAX_REQUEST_BODY_BYTES,
  PLAN_FREE,
  PRODUCT_ID_BUSINESS,
  PRO_IMAGE_RATE_LIMIT_PER_MINUTE,
  PRO_MONTHLY_IMAGE_LIMIT,
  QUOTA_UNIT_PPM,
  QUOTA_UNIT_TOKENS,
  STATUS,
  tierForProductId,
} from "./constants";
import type { PlanTier } from "./constants";
import type { Env, ProxyConfig } from "./config";
import {
  hasFreeUpstreamKey,
  hasImageGenKey,
  hasProUpstreamKey,
  readFreeUpstreamApiKey,
  readImageGenApiKey,
  readUpstreamApiKey,
  readUpstreamFallbackApiKey,
} from "./config";
import {
  calculateCostMicroUsd,
  DEFAULT_PRICE_TABLE,
  estimateFallbackUsage,
} from "./cost";
import type { DetailedUsage } from "./cost";
import {
  checkFreeChatRateLimit,
  clientIp,
  consumeFreeRateLimit,
  freeIpLimiterIdentity,
  freeLimiterIdentity,
} from "./free";
import { isBlockedRequest } from "./blocked";
import { isExemptRequest, matchesOperatorKey } from "./exempt";
import type { AuthorizeMeterOutcome, QuotaMode } from "./licence-meter";
import { callLicenceMeter, hasLiveLicenceMeter } from "./licence-meter";
import {
  checkTierTokenCaps,
  isGrantActive,
  maxInputTokensFor,
  maxRequestTokensFor,
  monthlyInputTokenLimitFor,
  monthlyOutputTokenLimitFor,
  periodIdFor,
  readTierUsage,
  recordTierUsage,
  requestCompletionCapFor,
  tierLabel,
  tokenLimitFor,
} from "./quota";
import type { QuotaHeaderInput } from "./responses";
import {
  quotaExceededResponse,
  quotaHeaders,
  rateLimitedResponse,
  subscriptionInactiveResponse,
} from "./responses";
import {
  createModelAliasRewriter,
  detailedUsageFromJsonBody,
  rewriteModelInJsonBody,
  SseInspector,
} from "./streaming";
import { findKeyByVirtualKey, newKeyRecord, readQuota, shortId } from "./store";
import type { KeyRecord } from "./store";
import { presentedKey } from "./provision";
import { isFreeGlobalCapReached, recordFreeGlobalSpend, secondsUntilUtcMidnight } from "./free-global";
import { DAY7_ACTIVE_THRESHOLD_MS, recordFunnelEventOnce } from "./funnel";
import { enforceToolCallsPerTurn, FREE_TOOL_CALLS_PER_MINUTE, isToolContinuation } from "./tool-budget";

/** A completion request body, as much of it as the proxy needs to look at. */
interface ChatCompletionRequest {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  thinking?: unknown;
  reasoning_effort?: unknown;
  [key: string]: unknown;
}

/**
 * Everything needed to call one managed upstream. Resolved from the key's tier, never from a
 * client-supplied header: a Free key can only ever reach the Free upstream, whatever it asks for.
 */
interface UpstreamTarget {
  tier: PlanTier;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  streamOptionsSupported: boolean;
}

function upstreamTargetFor(tier: PlanTier, env: Env, config: ProxyConfig): UpstreamTarget {
  if (tier === PLAN_FREE) {
    return {
      tier,
      baseUrl: config.freeUpstreamBaseUrl,
      modelId: config.freeUpstreamModelId,
      apiKey: readFreeUpstreamApiKey(env),
      streamOptionsSupported: true,
    };
  }
  return {
    tier,
    baseUrl: config.proUpstreamBaseUrl,
    modelId: config.proUpstreamModelId,
    apiKey: readUpstreamApiKey(env),
    streamOptionsSupported: true,
  };
}

function upstreamKeyConfigured(tier: PlanTier, env: Env): boolean {
  return tier === PLAN_FREE ? hasFreeUpstreamKey(env) : hasProUpstreamKey(env);
}

function requestedCompletionBudget(body: ChatCompletionRequest): number {
  const maxTokens =
    typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens) && body.max_tokens > 0
      ? Math.floor(body.max_tokens)
      : 0;
  const maxCompletionTokens =
    typeof body.max_completion_tokens === "number" &&
    Number.isFinite(body.max_completion_tokens) &&
    body.max_completion_tokens > 0
      ? Math.floor(body.max_completion_tokens)
      : 0;
  return Math.max(maxTokens, maxCompletionTokens);
}

/**
 * Rewrites the upstream request body.
 *
 * Deliberate changes:
 *  * the app-facing model id becomes the configured upstream model id for the caller's tier, so
 *    the provider's id is never the thing the client selects and never the thing the client sees;
 *  * `stream_options.include_usage` is forced to `true` whenever `stream` is set, so metering does
 *    not depend on the provider's defaults;
 *  * `max_tokens` / `max_completion_tokens` are clamped by tier and quota mode
 *    (`MAX_COMPLETION_TOKENS` Pro normal, `FREE_MAX_COMPLETION_TOKENS` Free, `4_096` reduced). This is the same number the pre-flight
 *    budget check uses (`requestCompletionCapFor`), so the clamp cannot be bypassed by a huge
 *    requested value;
 *  * thinking depth is enforced server-side:
 *    - `mode === "reduced"` (past the monthly cost soft cap): keep reasoning on at
 *      `reasoning_effort: "low"` (an explicit client off is honoured) — this is the efficiency mode
 *      that buys the margin back;
 *    - `mode === "normal"`: **high reasoning is enabled on both tiers**, Free included. A client
 *      that explicitly asked for no reasoning keeps it off; otherwise the request leaves with
 *      `thinking: { type: "enabled" }` and `reasoning_effort` defaulted to `"high"` when the caller
 *      did not name a depth. The Free tier is a full reasoning surface, and its US$0.35/month
 *      fair-use budget is sized for it.
 */
export function rewriteUpstreamBody(
  body: ChatCompletionRequest,
  config: ProxyConfig,
  options: { mode?: QuotaMode; tier?: PlanTier; overrideModelId?: string } = {},
): { body: ChatCompletionRequest; upstreamModel: string } {
  const tier: PlanTier = options.tier ?? tierForProductId(config.productId);
  const requested = typeof body.model === "string" ? body.model : "";
  const targetModel =
    options.overrideModelId ??
    (tier === PLAN_FREE ? config.freeUpstreamModelId : config.proUpstreamModelId);
  const isAppFacingId =
    requested === MANAGED_MODEL_ALIAS ||
    requested === FREE_MANAGED_MODEL_ID ||
    requested === FREE_MANAGED_MODEL_ALIAS ||
    requested === LEGACY_FREE_MANAGED_MODEL_ID;
  const upstreamModel = isAppFacingId ? targetModel : requested;
  const rewritten: ChatCompletionRequest = { ...body };
  if (upstreamModel !== "") rewritten["model"] = upstreamModel;

  const mode: QuotaMode = options.mode ?? "normal";
  const maxCompletionCap = requestCompletionCapFor(tier, mode);

  if (typeof rewritten["max_tokens"] === "number" && rewritten["max_tokens"] > maxCompletionCap) {
    rewritten["max_tokens"] = maxCompletionCap;
  }
  if (
    typeof rewritten["max_completion_tokens"] === "number" &&
    rewritten["max_completion_tokens"] > maxCompletionCap
  ) {
    rewritten["max_completion_tokens"] = maxCompletionCap;
  }

  const upstreamBaseUrl = (
    tier === PLAN_FREE ? config.freeUpstreamBaseUrl : config.proUpstreamBaseUrl
  ).toLowerCase();
  // Azure AI Foundry / Azure OpenAI endpoints enforce strict OpenAI schema and reject DeepSeek's
  // custom `thinking` object even when serving a DeepSeek model.
  const isAzureUpstream =
    upstreamBaseUrl.includes("azure.com") || upstreamBaseUrl.includes("azure.cn");
  const isDeepSeekUpstream =
    !isAzureUpstream &&
    (upstreamModel.toLowerCase().includes("deepseek") || upstreamBaseUrl.includes("deepseek"));

  if (mode === "reduced") {
    // Efficiency mode lowers thinking depth to "low" (instead of disabling reasoning) once the
    // $10.00 monthly soft cap is reached, unless the caller explicitly disabled thinking.
    const clientThinking = rewritten["thinking"];
    const clientDisabledThinking =
      clientThinking !== null &&
      typeof clientThinking === "object" &&
      (clientThinking as Record<string, unknown>)["type"] === "disabled";
    if (clientDisabledThinking) {
      if (isDeepSeekUpstream) {
        rewritten["thinking"] = { type: "disabled" };
      } else {
        delete rewritten["thinking"];
      }
      delete rewritten["reasoning_effort"];
    } else {
      if (isDeepSeekUpstream) {
        rewritten["thinking"] = { type: "enabled" };
      } else {
        delete rewritten["thinking"];
      }
      // Azure AI Foundry DeepSeek deployments reject "low" (HTTP 400) and accept only "high" or "none".
      rewritten["reasoning_effort"] = isAzureUpstream ? "none" : "low";
    }
  } else {
    // Normal mode: high reasoning is enabled on both tiers. Free used to have these fields stripped
    // outright, which made Free a non-reasoning surface; the only thing
    // that may lower depth now is the cost cap above.
    const clientThinking = rewritten["thinking"];
    const clientDisabledThinking =
      clientThinking !== null &&
      typeof clientThinking === "object" &&
      (clientThinking as Record<string, unknown>)["type"] === "disabled";

    if (clientDisabledThinking) {
      // An explicit "off" from the app is a user decision, not a provider-dialect accident.
      if (isDeepSeekUpstream) {
        rewritten["thinking"] = { type: "disabled" };
      } else {
        delete rewritten["thinking"];
      }
      delete rewritten["reasoning_effort"];
    } else if (tier === PLAN_FREE) {
      // Free thinking is locked to the route default: whatever depth a client names is dropped, so
      // the app's locked "Default" row and a direct API caller get the same thing. The default keeps
      // Free turns fast and tool-loop safe.
      delete rewritten["reasoning_effort"];
      if (isDeepSeekUpstream) {
        rewritten["thinking"] = { type: "disabled" };
      } else {
        delete rewritten["thinking"];
      }
    } else {
      if (!isDeepSeekUpstream) {
        // Only DeepSeek honours the `thinking` object; other OpenAI-compatible upstreams take the
        // effort field and reject an unknown thinking block.
        delete rewritten["thinking"];
      } else if (rewritten["thinking"] === undefined || rewritten["thinking"] === null) {
        // Default-on on Pro normal mode when no thinking config was supplied.
        rewritten["thinking"] = { type: "enabled" };
      }
      if (isDeepSeekUpstream && rewritten["reasoning_effort"] === undefined) {
        rewritten["reasoning_effort"] = "high";
      }
      // Gestu Managed AI offers no Max tier: a "max"/"xhigh" request is served at High.
      if (rewritten["reasoning_effort"] === "max" || rewritten["reasoning_effort"] === "xhigh") {
        rewritten["reasoning_effort"] = "high";
      }
    }
  }

  // Only enforce a fallback output cap in reduced mode; normal requests keep `max_tokens` blank when unset.
  if (mode === "reduced") {
    if (typeof rewritten["max_completion_tokens"] !== "number") {
      const existingMax =
        typeof rewritten["max_tokens"] === "number" && rewritten["max_tokens"] > 0
          ? Math.floor(rewritten["max_tokens"])
          : maxCompletionCap;
      rewritten["max_tokens"] = Math.min(existingMax, maxCompletionCap);
    }
  }

  if (body.stream === true) {
    const existing =
      body.stream_options !== null && typeof body.stream_options === "object"
        ? (body.stream_options as Record<string, unknown>)
        : {};
    rewritten["stream_options"] = { ...existing, include_usage: true };
  }
  return { body: rewritten, upstreamModel };
}

/**
 * True when the requested model is one this proxy will forward **for the caller's tier**.
 *
 * A Free key may only ask for the Free managed model ids; a Pro key may ask for the Pro alias (and
 * anything an operator explicitly exposed). Cross-tier requests are refused rather than silently
 * downgraded, so a client cannot probe which upstream a key is bound to.
 */
export function isAllowedModel(requested: string, config: ProxyConfig, tier: PlanTier = "pro"): boolean {
  if (tier === PLAN_FREE) {
    return (
      requested === FREE_MANAGED_MODEL_ID ||
      requested === FREE_MANAGED_MODEL_ALIAS ||
      requested === LEGACY_FREE_MANAGED_MODEL_ID
    );
  }
  if (requested === MANAGED_MODEL_ALIAS) return true;
  // Operators may expose the upstream ids as well; an empty list means "alias only".
  return config.exposedModels.includes(requested);
}

/**
 * The model id a response should carry: the id the client asked for, never the upstream's.
 *
 * For the Free route a missing/alias model resolves to the public `FREE_MANAGED_MODEL_ID`, which is
 * the id the app itself labels; for Pro a missing model resolves to the managed alias.
 */
export function clientVisibleModel(requested: string, tier: PlanTier): string {
  if (tier === PLAN_FREE) {
    return requested === LEGACY_FREE_MANAGED_MODEL_ID ? LEGACY_FREE_MANAGED_MODEL_ID : FREE_MANAGED_MODEL_ID;
  }
  return requested !== "" ? requested : MANAGED_MODEL_ALIAS;
}

export interface AuthorizedCaller {
  record: KeyRecord;
  quota: QuotaHeaderInput;
  mode: QuotaMode;
  tier: PlanTier;
  leaseId: string;
  /**
   * True when this device (or its address) is on the operator exemption list. An exempt caller is
   * authenticated exactly like any other — but the subscription's *limits* are not applied to it:
   * no allowance caps, no rate windows, no seat lease, and no counter is written for it. Revoked
   * and expired grants are still refused: a state is not a limit.
   */
  exempt: boolean;
}

/** Allowance shown for the operator master key: a real number, not a cap it can ever reach. */
const OPERATOR_QUOTA_TOKENS = 1_000_000_000;

/**
 * The caller for the operator master key.
 *
 * Synthesised per request: there is no KV lookup, no licence, and no meter. The record is never
 * written back, because `persistDetailedUsage` returns early for an exempt caller — a static
 * credential must not accumulate counters that some other device could later inherit.
 */
function operatorCaller(now: number): AuthorizedCaller {
  const record = newKeyRecord({
    keyId: "operator-master-key",
    packageName: "operator",
    productId: PRODUCT_ID_BUSINESS,
    obfuscatedAccountId: "operator",
    expiresAt: 0,
    status: STATUS.ACTIVE,
    playState: "",
    latestOrderId: "",
    deviceId: "operator-master-key",
    deviceLimit: 0,
    now,
  });
  return {
    record,
    quota: {
      usedTokens: 0,
      limitTokens: OPERATOR_QUOTA_TOKENS,
      periodId: periodIdFor(now),
      renewsAt: 0,
      unit: QUOTA_UNIT_TOKENS,
      mode: "normal",
      inputTokensUsed: 0,
      inputTokensLimit: OPERATOR_QUOTA_TOKENS,
      outputTokensUsed: 0,
      outputTokensLimit: OPERATOR_QUOTA_TOKENS,
    },
    mode: "normal",
    tier: tierForProductId(PRODUCT_ID_BUSINESS),
    leaseId: "",
    exempt: true,
  };
}

/**
 * Authenticates and authorizes one proxied request.
 *
 * Returns either the caller's key record with a fresh quota snapshot, or the `Response` to send
 * instead. The order matters: authenticate (401), then check the subscription (403), then check
 * the budget (429) — so a client can always tell which of the three is wrong.
 */export async function authorizeProxyRequest(input: {
  request: Request;
  env: Env;
  config: ProxyConfig;
  now: number;
  acquireLease?: boolean;
  promptHash?: string;
}): Promise<AuthorizedCaller | Response> {
  const { request, env, config, now } = input;
  const virtualKey = presentedKey(request);
  if (virtualKey === "") {
    return unauthorized("Missing subscription credential.");
  }

  // Operator master key: authenticates with no key record at all, so a stock client that has never
  // provisioned — and cannot be asked to provision again — still has a working credential.
  if (await matchesOperatorKey(env, virtualKey)) {
    return operatorCaller(now);
  }

  const record = await findKeyByVirtualKey(env.PRO_KV, virtualKey);
  if (record === null) {
    // Deliberately terse and identical for "wrong key" and "revoked key": the app's answer to 401
    // is to drop the key and re-provision, which is right in both cases.
    return unauthorized("Invalid or unknown virtual key.");
  }

  // A ban is resolved before the exemption and before any meter. It has to be: the app answers a
  // 401 by dropping the key and provisioning a new one, so revoking alone lets a banned device walk
  // straight back in. Answered with the same terse 401, so nothing reveals whether the key was
  // wrong, revoked, or banned.
  // `||`, not `!== ""`: a record written by `newKeyRecord` carries its device in `devices[0]` and
  // often has no top-level `deviceId` at all, and `undefined !== ""` is true — the old form passed
  // `undefined` into these lookups, which silently matches neither list.
  const recordDeviceId = record.deviceId || record.devices[0]?.deviceId;
  if (await isBlockedRequest(env, recordDeviceId, clientIp(input.request))) {
    return unauthorized("Invalid or unknown virtual key.");
  }

  // Operator exemption: the owner's own devices, and the networks they test from. Resolved once,
  // before any limit is consulted, so every branch below reads the same answer.
  const exempt = await isExemptRequest(env, recordDeviceId, clientIp(input.request));

  if (record.licenceId && hasLiveLicenceMeter(env)) {
    const outcome = await callLicenceMeter<AuthorizeMeterOutcome>(
      env.LICENCE_METER,
      record.licenceId,
      "authorizeRequest",
      {
        keyId: record.keyId,
        deviceId: record.deviceId,
        now,
        // An exempt device holds no stream lease: its concurrency ceiling does not apply.
        acquireLease: exempt ? false : (input.acquireLease ?? true),
        promptHash: input.promptHash,
      },
    );
    const tier = outcome.usage.tier ?? tierForProductId(outcome.state.plan || record.productId);
    const quota: QuotaHeaderInput = {
      usedTokens: outcome.usage.usedPpm,
      limitTokens: outcome.usage.limitPpm,
      periodId: outcome.usage.periodId,
      renewsAt: outcome.usage.renewsAt,
      unit: QUOTA_UNIT_PPM,
      mode: outcome.usage.mode,
      inputTokensUsed: outcome.usage.inputTokens,
      inputTokensLimit: outcome.usage.monthlyInputTokenLimit,
      outputTokensUsed: outcome.usage.outputTokens,
      outputTokensLimit: outcome.usage.monthlyOutputTokenLimit,
    };

    if (!outcome.allowed) {
      if (outcome.httpStatus === 403) {
        if (!exempt && tier === PLAN_FREE && outcome.reason === "expired") {
          await recordFunnelEventOnce(
            env,
            "trial_cap_hit",
            record.meterId ?? record.licenceId ?? record.keyId,
            now,
          );
        }
        const denial = outcome.reason === "revoked" ? DENIAL.REVOKED : DENIAL.EXPIRED;
        return subscriptionInactiveResponse(denial, outcome.message, quotaHeaders(quota));
      }
      if (!exempt) {
        if (outcome.reason === "rate_limited") {
          return rateLimitedResponse(quota, outcome.retryAfterSeconds ?? 15, outcome.message);
        }
        if (tier === PLAN_FREE && outcome.reason === "quota_exceeded") {
          await recordFunnelEventOnce(
            env,
            "trial_cap_hit",
            record.meterId ?? record.licenceId ?? record.keyId,
            now,
          );
        }
        return quotaExceededResponse(quota, {}, outcome.message, outcome.reason);
      }
      // Exempt device that would otherwise have been stopped by a cap, window or seat limit: serve
      // it in normal mode with no lease. The header snapshot above keeps the metered numbers, so
      // the client still renders a quota bar rather than a blank.
      return { record, quota, mode: "normal", tier, leaseId: "", exempt };
    }

    return {
      record,
      quota,
      mode: outcome.mode,
      tier,
      leaseId: outcome.leaseId,
      exempt,
    };
  }

  const tier = tierForProductId(record.productId);
  // Free keys meter under a stable device id, not the rotating key id: a reinstall must not reset
  // the device's month. Pro keys have no `meterId`, so this is their key id, exactly as before.
  const meterId = record.meterId ?? record.keyId;
  const tierUsage = await readTierUsage(env.PRO_KV, meterId, now);
  const outputLimit = monthlyOutputTokenLimitFor(record.productId);
  const inputLimit = monthlyInputTokenLimitFor(record.productId);
  const rawQuota = await readQuota(env.PRO_KV, meterId, tokenLimitFor(record.productId, config), now);
  const quota: QuotaHeaderInput = {
    // The app's meter shows the *output* allowance — the number the plan advertises (200,000 Free,
    // 1,500,000 Pro). The month's input cost control is enforced below and exposed in dedicated headers.
    usedTokens: tierUsage.outputTokens,
    limitTokens: outputLimit,
    periodId: rawQuota.periodId,
    renewsAt: rawQuota.renewsAt,
    unit: record.quotaUnit ?? QUOTA_UNIT_TOKENS,
    mode: "normal",
    inputTokensUsed: tierUsage.inputTokens,
    inputTokensLimit: inputLimit,
    outputTokensUsed: tierUsage.outputTokens,
    outputTokensLimit: outputLimit,
  };

  if (!isGrantActive(record.status, record.expiresAt, now)) {
    const reason = record.status === "revoked" ? DENIAL.REVOKED : DENIAL.EXPIRED;
    if (!exempt && tier === PLAN_FREE && reason === DENIAL.EXPIRED) {
      await recordFunnelEventOnce(env, "trial_cap_hit", meterId, now);
    }
    const message =
      tier === PLAN_FREE && reason === DENIAL.EXPIRED
        ? "Your 7-day Gestu Free trial has ended. Upgrade to Gestu Pro, use an on-device model, or add your own API key in Settings."
        : `This ${tierLabel(tier)} subscription is ${record.status}. Renew it in Google Play, or add your own API key in Settings.`;
    return subscriptionInactiveResponse(reason, message, quotaHeaders(quota));
  }

  // Belt-and-braces combined ceiling. The split caps below are the product promise; this catches a
  // counter that drifted and keeps `used` from ever exceeding what the two caps allow together.
  // An exempt device is not held to either: its counters are never written, so they stay at zero,
  // but the check is skipped explicitly rather than relying on that.
  if (!exempt) {
    if (rawQuota.limitTokens > 0 && rawQuota.usedTokens >= rawQuota.limitTokens) {
      if (tier === PLAN_FREE) {
        await recordFunnelEventOnce(env, "trial_cap_hit", meterId, now);
      }
      return quotaExceededResponse(quota, {}, quotaExhaustedMessage(tier, quota, record.productId), "quota_exceeded");
    }

    const capCheck = checkTierTokenCaps(tierUsage, record.productId, rawQuota.periodId);
    if (!capCheck.allowed) {
      if (tier === PLAN_FREE) {
        await recordFunnelEventOnce(env, "trial_cap_hit", meterId, now);
      }
      return quotaExceededResponse(quota, {}, capCheck.message, "quota_exceeded");
    }
  }

  return { record, quota, mode: "normal", tier, leaseId: "", exempt };
}

/**
 * A user-facing exhaustion sentence that names the right allowance and numbers.
 *
 * It deliberately mentions both Pro caps when the output side is what remains displayed, because a
 * user who hit the 100,000,000-input cost control while their 1,500,000-output meter still shows
 * headroom would otherwise be looking at a contradiction.
 */
function quotaExhaustedMessage(
  tier: PlanTier,
  quota: QuotaHeaderInput,
  productId: string,
): string {
  const inputLimit = monthlyInputTokenLimitFor(productId);
  return (
    `${tierLabel(tier)} monthly allowance for ${quota.periodId} is used up ` +
    `(${quota.usedTokens} of ${quota.limitTokens} output tokens, ${inputLimit} input-token cap). ` +
    "The allowance resets on the 1st."
  );
}

async function releaseCallerLease(caller: AuthorizedCaller, env: Env): Promise<void> {
  if (caller.leaseId && caller.record.licenceId && hasLiveLicenceMeter(env)) {
    try {
      await callLicenceMeter(env.LICENCE_METER, caller.record.licenceId, "releaseLease", {
        leaseId: caller.leaseId,
      });
    } catch {
      // Lease will auto-expire after 60s.
    }
  }
}

function unauthorized(message: string): Response {
  return new Response(
    JSON.stringify({
      error: { message, type: "invalid_request_error", code: "invalid_api_key", param: null },
    }),
    {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    },
  );
}

/** Header block for a proxied answer: the client's mirror plus any extra headers. */
function proxyHeaders(
  quota: AuthorizedCaller["quota"],
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...quotaHeaders(quota), ...extra };
}

/**
 * `POST /v1/chat/completions`.
 *
 * Never throws for an upstream problem: every upstream failure is mapped to a clean, stable
 * Gestu-branded error body. The provider's own error body, headers, name, URL and any credential it
 * mentions are dropped entirely — the client only ever sees `error.message`/`error.code` in the
 * vocabulary its own `Requests.kt` understands.
 *
 * The Free tier is additionally rate-limited per IP+device before any budget is spent, and refuses
 * with a `429` + `Retry-After` + the standard quota headers (the numbers unchanged, so the app does
 * not mistake an anti-abuse throttle for an exhausted allowance).
 */
export async function handleChatCompletions(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now = Date.now(),
  ctx?: ExecutionContext,
): Promise<Response> {
  const caller = await authorizeProxyRequest({ request, env, config, now });
  if (caller instanceof Response) return caller;

  // PII-free Day-7 retention counter: fires at most once per opaque meter/licence when a returning
  // user makes a request 6+ days after first seen. Skips KV completely when FUNNEL_DB is unbound.
  if (!caller.exempt) {
    const firstSeenAt = caller.record.trialStartedAt ?? caller.record.devices[0]?.firstSeenAt ?? 0;
    if (firstSeenAt > 0 && now - firstSeenAt >= DAY7_ACTIVE_THRESHOLD_MS) {
      const dedupeId = caller.record.meterId ?? caller.record.licenceId ?? caller.record.keyId;
      await recordFunnelEventOnce(env, "day7_active", dedupeId, now);
    }
  }

  // Only the Free tier has a request-rate throttle. Pro is deliberately unthrottled per minute:
  // what bounds a Pro account is the LicenceMeter spend cap and the monthly token allowance, and
  // both are charged per request, so a burst can exhaust an allowance sooner but cannot exceed it.
  // A per-minute ceiling on top of that shaped traffic without changing the worst case — it only
  // made a paying customer wait.
  if (!caller.exempt && caller.tier === PLAN_FREE) {
    const identity = await freeLimiterIdentity(
      request,
      caller.record.deviceId ?? caller.record.devices[0]?.deviceId ?? caller.record.keyId,
    );
    const ipIdentity = await freeIpLimiterIdentity(request);
    const limit = await checkFreeChatRateLimit(env, identity, now, ipIdentity);
    if (!limit.allowed) {
      await releaseCallerLease(caller, env);
      console.warn(`proxy: free route rate limited for ${shortId(caller.record.keyId)} (${limit.scope})`);
      return rateLimitedResponse(caller.quota, limit.retryAfterSeconds);
    }
  }

  const target = upstreamTargetFor(caller.tier, env, config);
  if (!upstreamKeyConfigured(caller.tier, env)) {
    await releaseCallerLease(caller, env);
    console.error(
      `proxy: ${caller.tier} upstream credential is not configured — refusing to forward (fail closed)`,
    );
    return new Response(
      JSON.stringify({
        error: {
          message:
            caller.tier === PLAN_FREE
              ? "The Gestu Free managed route is not configured. Add your own API key in Settings meanwhile."
              : "The managed proxy is not configured. Use your own API key in Settings meanwhile.",
          type: "gestu_server_error",
          code: "server_misconfigured",
          param: null,
        },
      }),
      { status: 503, headers: proxyHeaders(caller.quota, { "content-type": "application/json" }) },
    );
  }

  const rawBody = await request.text();
  const requestBytes = new TextEncoder().encode(rawBody).byteLength;
  if (requestBytes > MAX_REQUEST_BODY_BYTES) {
    await releaseCallerLease(caller, env);
    return new Response(
      JSON.stringify({
        error: {
          message: `Request body exceeds maximum size of ${MAX_REQUEST_BODY_BYTES} bytes.`,
          type: "invalid_request_error",
          code: "request_too_large",
          param: null,
        },
      }),
      { status: 413, headers: proxyHeaders(caller.quota, { "content-type": "application/json" }) },
    );
  }

  let parsedBody: ChatCompletionRequest;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    parsedBody = parsed as ChatCompletionRequest;
  } catch {
    await releaseCallerLease(caller, env);
    return new Response(
      JSON.stringify({
        error: { message: "Request body must be a JSON object.", type: "invalid_request_error", code: null },
      }),
      { status: 400, headers: proxyHeaders(caller.quota, { "content-type": "application/json" }) },
    );
  }

  const requestedModel = typeof parsedBody.model === "string" ? parsedBody.model : "";
  if (requestedModel !== "" && !isAllowedModel(requestedModel, config, caller.tier)) {
    await releaseCallerLease(caller, env);
    return new Response(
      JSON.stringify({
        error: {
          message: `Model '${requestedModel}' is not available on the managed route.`,
          type: "invalid_request_error",
          code: "model_not_found",
          param: "model",
        },
      }),
      { status: 404, headers: proxyHeaders(caller.quota, { "content-type": "application/json" }) },
    );
  }

  if (caller.tier === PLAN_FREE) {
    // Global Free circuit breaker: once all Free traffic has spent the daily cap, Free answers
    // "busy, try later" until midnight UTC. Pro is never affected.
    if (!caller.exempt && (await isFreeGlobalCapReached(env, now))) {
      await releaseCallerLease(caller, env);
      console.warn("proxy: free route paused, global daily spend cap reached");
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Gestu Free is busy right now. Please try again later, or use your own API key or an on-device model meanwhile.",
            type: "gestu_server_busy",
            code: "free_capacity_reached",
            param: null,
          },
        }),
        {
          status: 503,
          headers: proxyHeaders(caller.quota, {
            "content-type": "application/json",
            "retry-after": String(secondsUntilUtcMidnight(now)),
          }),
        },
      );
    }
    // Tool loops are rate-limited apart from ordinary chat: every tool round is a paid request.
    if (!caller.exempt && isToolContinuation(parsedBody.messages)) {
      const toolIdentity = await freeLimiterIdentity(
        request,
        caller.record.deviceId ?? caller.record.devices[0]?.deviceId ?? caller.record.keyId,
      );
      const toolLimit = await consumeFreeRateLimit({
        env,
        scope: "free-tool-minute",
        identity: toolIdentity,
        max: FREE_TOOL_CALLS_PER_MINUTE,
        windowMs: FREE_CHAT_RATE_WINDOW_MS,
        now,
        useBinding: false,
      });
      if (!toolLimit.allowed) {
        await releaseCallerLease(caller, env);
        return rateLimitedResponse(
          caller.quota,
          toolLimit.retryAfterSeconds,
          "Too many tool calls this minute on Gestu Free. Please wait a moment.",
        );
      }
    }
  }
  // Per-turn tool-call budget (Free 6, Pro 60): at the cap the model must answer in text.
  if (enforceToolCallsPerTurn(parsedBody, caller.tier)) {
    console.info(`proxy: tool-call budget reached for ${shortId(caller.record.keyId)} (${caller.tier}); tools disabled for this request`);
  }

  const estimatedInputTokens = Math.ceil(requestBytes / 4);
  const maxInputTokens = maxInputTokensFor(caller.tier);
  if (estimatedInputTokens > maxInputTokens) {
    await releaseCallerLease(caller, env);
    return new Response(
      JSON.stringify({
        error: {
          code: "request_budget_exceeded",
          message: `Estimated input tokens (${estimatedInputTokens}) exceed the ${tierLabel(caller.tier)} limit of ${maxInputTokens} input tokens per request.`,
          type: "invalid_request_error",
          param: "messages",
        },
      }),
      { status: 413, headers: proxyHeaders(caller.quota, { "content-type": "application/json" }) },
    );
  }

  // Clamp BEFORE the pre-flight estimate, with the same number `rewriteUpstreamBody` will write
  // outbound. A hostile `max_tokens: 10_000_000` therefore cannot fail this check while the
  // clamped body would pass it, and cannot slip past the clamp either.
  const completionCap = requestCompletionCapFor(caller.tier, caller.mode);
  const requestedOutputTokens = requestedCompletionBudget(parsedBody);
  const maxRequestTokens = maxRequestTokensFor(caller.tier);
  const availableContextOutput = Math.max(0, maxRequestTokens - estimatedInputTokens);
  if (
    caller.tier !== PLAN_FREE &&
    requestedOutputTokens > 0 &&
    estimatedInputTokens + Math.min(requestedOutputTokens, completionCap) > maxRequestTokens &&
    availableContextOutput > 0
  ) {
    // Clamp requested output to fit within the 1M total context window on Pro.
    const clampedToWindow = Math.min(completionCap, availableContextOutput);
    if (typeof parsedBody.max_tokens === "number") parsedBody.max_tokens = clampedToWindow;
    if (typeof parsedBody.max_completion_tokens === "number") parsedBody.max_completion_tokens = clampedToWindow;
  }
  const effectiveOutputTokens =
    requestedOutputTokens > 0
      ? Math.min(
          typeof parsedBody.max_tokens === "number"
            ? parsedBody.max_tokens
            : requestedOutputTokens,
          completionCap,
        )
      : 0;
  if (estimatedInputTokens + effectiveOutputTokens > maxRequestTokens) {
    await releaseCallerLease(caller, env);
    return new Response(
      JSON.stringify({
        error: {
          code: "request_budget_exceeded",
          message: `Estimated request tokens (${estimatedInputTokens + effectiveOutputTokens}) exceed the ${tierLabel(caller.tier)} per-request budget of ${maxRequestTokens} tokens.`,
          type: "invalid_request_error",
          param: "max_tokens",
        },
      }),
      { status: 400, headers: proxyHeaders(caller.quota, { "content-type": "application/json" }) },
    );
  }

  const { body, upstreamModel } = rewriteUpstreamBody(parsedBody, config, {
    mode: caller.mode,
    tier: caller.tier,
  });
  const streamRequested = parsedBody.stream === true;
  const acceptHeader = streamRequested ? "text/event-stream" : "application/json";
  const visibleModel = clientVisibleModel(requestedModel, caller.tier);

  let upstream: Response | null = null;
  let activeUpstreamModel = upstreamModel;

  try {
    upstream = await postChatCompletions(target, body, acceptHeader);
  } catch (error) {
    console.error(
      `proxy: ${caller.tier} upstream fetch failed (${error instanceof Error ? error.name : "unknown"})`,
    );
  }

  // Some OpenAI-compatible providers reject `stream_options`. The Free upstream is the one we
  // cannot assume: retry once without it rather than fail a valid turn. Metering falls back to the
  // byte-count estimate for that stream (already the documented behaviour for a stream with no
  // usage chunk).
  if (
    upstream !== null &&
    upstream.status === 400 &&
    caller.tier === PLAN_FREE &&
    streamRequested &&
    target.streamOptionsSupported
  ) {
    console.warn("proxy: free upstream rejected the request with stream_options; retrying without it");
    const retryBody: ChatCompletionRequest = { ...body };
    delete retryBody["stream_options"];
    try {
      upstream = await postChatCompletions(target, retryBody, acceptHeader);
    } catch (error) {
      console.error(
        `proxy: free upstream retry failed (${error instanceof Error ? error.name : "unknown"})`,
      );
    }
  }

  // Optional secondary managed-host failover for the Pro route only. The fallback must never target
  // the default upstream (that would be a silent second provider), and it is configuration the
  // operator owns, not a residency promise.
  const canTryFallbackUpstream =
    caller.tier !== PLAN_FREE &&
    config.upstreamFallbackBaseUrl !== undefined &&
    config.upstreamFallbackBaseUrl !== "" &&
    !config.upstreamFallbackBaseUrl.includes("api.deepseek.com") &&
    (upstream === null || upstream.status === 502 || upstream.status === 503 || upstream.status === 504);

  if (canTryFallbackUpstream) {
    const fallbackModel = config.upstreamFallbackModelId || config.proUpstreamModelId;
    const rewrittenFallback = rewriteUpstreamBody(parsedBody, config, {
      mode: caller.mode,
      tier: caller.tier,
      overrideModelId: fallbackModel,
    });
    try {
      upstream = await fetch(`${config.upstreamFallbackBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${readUpstreamFallbackApiKey(env)}`,
          "content-type": "application/json",
          accept: acceptHeader,
        },
        body: JSON.stringify(rewrittenFallback.body),
      });
      activeUpstreamModel = rewrittenFallback.upstreamModel;
    } catch (fallbackErr) {
      console.error(
        `proxy: fallback upstream fetch failed (${fallbackErr instanceof Error ? fallbackErr.name : "unknown"})`,
      );
    }
  }

  if (upstream === null) {
    await releaseCallerLease(caller, env);
    return new Response(
      JSON.stringify({
        error: {
          message: "Could not reach the managed model service.",
          type: "gestu_upstream_unreachable",
          code: "upstream_unreachable",
          param: null,
        },
      }),
      { status: 502, headers: proxyHeaders(caller.quota, { "content-type": "application/json" }) },
    );
  }

  if (!upstream.ok) {
    await releaseCallerLease(caller, env);
    return sanitizedUpstreamFailure(upstream.status, caller);
  }

  const isStream = upstream.headers.get("content-type")?.includes("text/event-stream") === true;
  if (isStream) {
    return streamedCompletion({
      upstream,
      caller,
      env,
      config,
      upstreamModel: activeUpstreamModel,
      visibleModel,
      requestBytes,
      now,
      ctx,
    });
  }
  return bufferedCompletion({
    upstream,
    caller,
    env,
    config,
    upstreamModel: activeUpstreamModel,
    visibleModel,
    requestBytes,
    now,
  });
}

/** POSTs one chat-completions body to a managed upstream with that upstream's own credential. */
function postChatCompletions(
  target: UpstreamTarget,
  body: ChatCompletionRequest,
  acceptHeader: string,
): Promise<Response> {
  return fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.apiKey}`,
      "content-type": "application/json",
      accept: acceptHeader,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Maps any upstream failure to a clean Gestu-branded answer.
 *
 * The upstream body is **never** forwarded: provider error payloads contain provider names, doc
 * URLs, request ids and sometimes fragments of auth diagnostics, and none of that belongs in front
 * of a customer — nor does it help debugging, because the operator reads the Worker log. The mapped
 * status keeps the client's existing retry/final semantics:
 *
 *  * `400`-class → `400` (the request itself is wrong; retrying unchanged will not help);
 *  * provider auth/balance/route/rate-limit failures → `503 upstream_unavailable`, which the app
 *    treats as transient and retries — this is an operator problem, not the user's;
 *  * anything else → `502 upstream_unreachable`/`upstream_unavailable`, also retryable.
 *
 * No branch names the provider, its host, its key, or echoes its message.
 */
export function sanitizedUpstreamFailure(upstreamStatus: number, caller: AuthorizedCaller): Response {
  const headers = proxyHeaders(caller.quota);
  if (upstreamStatus === 400 || upstreamStatus === 413 || upstreamStatus === 422) {
    console.warn(`proxy: upstream rejected the request (status 400-class)`);
    return jsonProxyError(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "The model rejected this request. Check the model and parameters and try again.",
      headers,
    );
  }
  if (upstreamStatus === 401 || upstreamStatus === 403 || upstreamStatus === 402 || upstreamStatus === 404) {
    console.error(
      `CRITICAL: managed upstream credential/route/balance failure (status ${upstreamStatus}) — check the Worker secret and upstream configuration`,
    );
    return jsonProxyError(
      503,
      "gestu_upstream_unavailable",
      "upstream_unavailable",
      "The managed model service is temporarily unavailable. Please try again shortly.",
      headers,
    );
  }
  if (upstreamStatus === 429) {
    console.warn("proxy: upstream rate limited the Worker");
    return jsonProxyError(
      503,
      "gestu_upstream_unavailable",
      "upstream_unavailable",
      "The managed model is busy right now. Please try again shortly.",
      headers,
    );
  }
  console.error(`proxy: upstream failure (status ${upstreamStatus})`);
  return jsonProxyError(
    502,
    "gestu_upstream_unreachable",
    "upstream_unreachable",
    "Could not reach the managed model service. Please try again shortly.",
    headers,
  );
}

/** Builds an OpenAI-shaped proxy error without touching an upstream response. */
function jsonProxyError(
  status: number,
  type: string,
  code: string,
  message: string,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: { message, type, code, param: null } }), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function persistDetailedUsage(input: {
  caller: AuthorizedCaller;
  env: Env;
  config: ProxyConfig;
  detailed: DetailedUsage;
  now: number;
}): Promise<void> {
  const { caller, env, config, detailed, now } = input;
  const totalTokens = detailed.promptTokens + detailed.completionTokens;

  // Emitted before any branch: the Pro path returns early (its exact counters live in the
  // Durable Object), and telemetry must cover both tiers or the report has a hole in it.
  reportUsageTelemetry(env, caller, detailed, now);

  // An exempt device is never metered: no allowance is consumed, no spend is accumulated against
  // the licence meter, and no counter can drift toward a cap that does not apply to it. Telemetry
  // above still records the request, so usage stays visible in the operator report.
  if (caller.exempt) return;

  if (caller.record.licenceId && hasLiveLicenceMeter(env)) {
    const upstreamBase =
      caller.tier === PLAN_FREE ? config.freeUpstreamBaseUrl : config.proUpstreamBaseUrl;
    let upstreamHost: string | undefined;
    try {
      upstreamHost = new URL(upstreamBase).hostname.toLowerCase();
    } catch {
      upstreamHost = undefined;
    }
    const costMicroUsd = calculateCostMicroUsd({
      usage: detailed,
      model: caller.tier === PLAN_FREE ? config.freeUpstreamModelId : config.proUpstreamModelId,
      upstreamHost,
      priceTable: config.priceTable ?? DEFAULT_PRICE_TABLE,
      now,
    });
    await callLicenceMeter(env.LICENCE_METER, caller.record.licenceId, "recordSpend", {
      periodId: periodIdFor(now),
      costMicroUsd,
      tokens: totalTokens,
      inputTokens: detailed.promptTokens,
      outputTokens: detailed.completionTokens,
      leaseId: caller.leaseId,
      now,
    });
    if (caller.tier !== PLAN_FREE) {
      return;
    }
    await recordFreeGlobalSpend(env, costMicroUsd, now);
  }

  if (totalTokens > 0) {
    // One record, one KV write. `recordTierUsage` now carries the combined total as well as the
    // split, so `recordUsage` no longer writes a second key for the same request. The meter id,
    // not the key id: a Free key rotates its secret on reinstall but the device's monthly
    // allowance must survive that rotation.
    const meterId = caller.record.meterId ?? caller.record.keyId;
    await recordTierUsage(env.PRO_KV, meterId, detailed.promptTokens, detailed.completionTokens, now);
  }
}

/**
 * Emits per-request usage to the two *lossy* channels: a structured log line and, when the
 * binding exists, an Analytics Engine data point.
 *
 * Deliberately separate from the counters above. Those are exact and are what a quota decision
 * reads; these exist to answer "who called what, and when" — a forensic question, not a billing
 * one. Workers Logs only retains a sample (`head_sampling_rate` in `wrangler.toml`), so a report
 * built from these numbers will always undercount. Use `/admin/usage` for anything that must
 * reconcile.
 *
 * Both writes are wrapped: a telemetry failure must never fail a completion that has already been
 * paid for upstream, and `writeDataPoint` is fire-and-forget by contract.
 *
 * The log line carries `shortId(meterId)`, never the virtual key — the same rule the existing
 * warn paths follow, so a log dump cannot be replayed as a credential.
 */
function reportUsageTelemetry(
  env: Env,
  caller: AuthorizedCaller,
  detailed: DetailedUsage,
  now: number,
): void {
  const meterId = caller.record.meterId ?? caller.record.keyId;
  const total = detailed.promptTokens + detailed.completionTokens;

  try {
    console.log(
      JSON.stringify({
        evt: "chat.usage",
        at: new Date(now).toISOString(),
        meter: shortId(meterId),
        tier: caller.tier,
        product: caller.record.productId ?? "",
        prompt: detailed.promptTokens,
        completion: detailed.completionTokens,
        cacheHit: detailed.cacheHitTokens,
        cacheMiss: detailed.cacheMissTokens,
        total,
      }),
    );
  } catch {
    // A logger that throws is not a reason to fail a metered request.
  }

  const analytics = env.USAGE_ANALYTICS;
  if (analytics === undefined) return;
  try {
    analytics.writeDataPoint({
      // One index: Analytics Engine samples on it, so per-meter rows stay attributable.
      indexes: [meterId],
      blobs: [caller.tier, caller.record.productId ?? "", caller.record.licenceId ?? ""],
      doubles: [detailed.promptTokens, detailed.completionTokens, total, now],
    });
  } catch {
    // Same rule: telemetry is best-effort.
  }
}

async function bufferedCompletion(input: {
  upstream: Response;
  caller: AuthorizedCaller;
  env: Env;
  config: ProxyConfig;
  upstreamModel: string;
  visibleModel: string;
  requestBytes: number;
  now: number;
}): Promise<Response> {
  const { upstream, caller, env, config, upstreamModel, visibleModel, requestBytes, now } = input;
  const text = await upstream.text();

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn("proxy: upstream 200 body was not JSON; forwarding without metering");
  }

  // A 200 carrying an error envelope is an upstream failure, not an answer. Forwarding it would put
  // the provider's wording in front of the customer; treat it as the retryable outage it is.
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "error" in (parsed as Record<string, unknown>)
  ) {
    await releaseCallerLease(caller, env);
    console.error("proxy: upstream returned HTTP 200 with an error body — masking as 502 upstream_unreachable");
    return jsonProxyError(
      502,
      "gestu_upstream_unreachable",
      "upstream_unreachable",
      "Could not reach the managed model service. Please try again shortly.",
      proxyHeaders(caller.quota),
    );
  }

  let detailed: DetailedUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
  };
  if (parsed !== null) detailed = detailedUsageFromJsonBody(parsed);

  if (detailed.promptTokens === 0 && detailed.completionTokens === 0 && text.length > 0) {
    detailed = estimateFallbackUsage(requestBytes, new TextEncoder().encode(text).byteLength);
  }

  await persistDetailedUsage({ caller, env, config, detailed, now });

  const headers = safeUpstreamHeaders(upstream);
  for (const [name, value] of Object.entries(proxyHeaders(caller.quota))) headers.set(name, value);
  // The client sees the model id it asked for, never the upstream's.
  return new Response(rewriteModelInJsonBody(text, upstreamModel, visibleModel), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * Streams the answer through untouched while metering it.
 */
function streamedCompletion(input: {
  upstream: Response;
  caller: AuthorizedCaller;
  env: Env;
  config: ProxyConfig;
  upstreamModel: string;
  visibleModel: string;
  requestBytes: number;
  now: number;
  ctx?: ExecutionContext;
}): Response {
  const { upstream, caller, env, config, upstreamModel, visibleModel, requestBytes, now, ctx } = input;
  if (upstream.body === null) {
    void releaseCallerLease(caller, env);
    console.error("proxy: upstream returned an event stream with no body");
    return new Response(null, { status: 502, headers: proxyHeaders(caller.quota) });
  }

  const aliased = upstream.body.pipeThrough(createModelAliasRewriter(upstreamModel, visibleModel));
  const [toClient, toInspector] = aliased.tee();

  // The meter branch is detached from the client response, so it is also detached from the
  // request's error handling. Catch here or a quota-write failure becomes an unhandled rejection in
  // the Workers runtime (and a lost `waitUntil` promise).
  const meter = meterStream({
    stream: toInspector,
    caller,
    env,
    config,
    now,
    upstreamModel,
    requestBytes,
  }).catch((error) => {
    console.error(
      `proxy: metering failed for ${shortId(caller.record.keyId)} (${error instanceof Error ? error.name : "unknown"})`,
    );
  });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(meter);
  } else {
    try {
      (globalThis as { event?: { waitUntil?: (promise: Promise<unknown>) => void } }).event?.waitUntil?.(meter);
    } catch {
      void meter;
    }
  }

  const headers = safeUpstreamHeaders(upstream);
  for (const [name, value] of Object.entries(proxyHeaders(caller.quota))) headers.set(name, value);
  return new Response(toClient, { status: upstream.status, statusText: upstream.statusText, headers });
}

/**
 * The upstream response headers that may be forwarded to a client.
 *
 * Only the content type matters to the app. Everything else an upstream sends — `server`, provider
 * request ids, rate-limit metadata, cookies — is either useless to the client or identifies the
 * private provider, so it is dropped rather than reflected.
 */
function safeUpstreamHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) headers.set("content-type", contentType);
  return headers;
}

/**
 * Drains the inspection branch and records what it saw.
 */
async function meterStream(input: {
  stream: ReadableStream<Uint8Array>;
  caller: AuthorizedCaller;
  env: Env;
  config: ProxyConfig;
  now: number;
  upstreamModel: string;
  requestBytes: number;
}): Promise<void> {
  const { stream, caller, env, config, now, requestBytes } = input;
  const inspector = new SseInspector();
  const reader = stream.getReader();
  let firstTokenMs = 0;
  let leaseHandled = false;
  const startedAt = Date.now();
  try {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        if (firstTokenMs === 0) firstTokenMs = Date.now() - startedAt;
        inspector.inspect(value);
      }
      inspector.flush();
    } catch (error) {
      console.warn(`proxy: meter stream ended early (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Already closed; nothing to release.
      }
    }

    let detailed = inspector.detailedCounts();
    if (detailed.promptTokens === 0 && detailed.completionTokens === 0) {
      if (inspector.bytesSeen() > 0) {
        detailed = estimateFallbackUsage(requestBytes, inspector.bytesSeen());
        console.warn(
          `proxy: stream ended without usage chunk for ${shortId(caller.record.keyId)}; ` +
            `estimated ${detailed.promptTokens}+${detailed.completionTokens} tokens from byte counts`,
        );
      } else {
        await releaseCallerLease(caller, env);
        leaseHandled = true;
        console.warn(
          `proxy: no usage reported for ${shortId(caller.record.keyId)} (first token ${firstTokenMs} ms); nothing metered`,
        );
        return;
      }
    }

    await persistDetailedUsage({ caller, env, config, detailed, now });
    leaseHandled = true;
  } finally {
    if (!leaseHandled) {
      await releaseCallerLease(caller, env);
    }
  }
}

/**
 * `GET /v1/models` — the alias list, in OpenAI's list shape.
 *
 * Both managed tiers are advertised because one gateway serves both: the Pro alias and the Free
 * model id (which is the public name the app labels, not a provider credential). Operator-exposed
 * ids are added first, deduplicated.
 */
export function handleModels(env: Env, config: ProxyConfig): Response {
  void env;
  const ids = [
    ...config.exposedModels,
    MANAGED_MODEL_ALIAS,
    FREE_MANAGED_MODEL_ID,
    FREE_MANAGED_MODEL_ALIAS,
  ].filter((id, index, all) => id !== "" && all.indexOf(id) === index);
  const models = ids.map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "gestu",
  }));
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * `POST /v1/images/generations` — Pro-only managed image generation proxy.
 *
 * Authenticates the caller's Pro virtual key (`gsk_...`), refuses Free-tier keys (`403`), enforces
 * per-minute (`10/min`) and monthly (`200/mo`) image caps, and forwards the request server-to-server
 * to `gestu-image-gen` using `IMAGE_GEN_API_KEY` so no shared secret ever ships in the client APK.
 */
export async function handleImageGenerations(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now = Date.now(),
): Promise<Response> {
  const caller = await authorizeProxyRequest({ request, env, config, now, acquireLease: false });
  if (caller instanceof Response) return caller;

  if (caller.tier === PLAN_FREE) {
    return subscriptionInactiveResponse(
      DENIAL.EXPIRED,
      "Managed image generation is a Gestu Pro feature. Upgrade to Gestu Pro or add your own image API key in Settings.",
      quotaHeaders(caller.quota),
    );
  }

  if (!hasImageGenKey(env)) {
    console.error("proxy: IMAGE_GEN_API_KEY is not configured — refusing Pro image generation (fail closed)");
    return jsonProxyError(
      503,
      "gestu_server_error",
      "server_misconfigured",
      "Managed image generation is not configured on this server.",
      proxyHeaders(caller.quota),
    );
  }

  const meterId = caller.record.licenceId ?? caller.record.meterId ?? caller.record.keyId;
  const minuteLimit = await consumeFreeRateLimit({
    env,
    scope: "pro-image-minute",
    identity: meterId,
    max: PRO_IMAGE_RATE_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    now,
    useBinding: false,
  });
  if (!minuteLimit.allowed) {
    return rateLimitedResponse(caller.quota, minuteLimit.retryAfterSeconds);
  }

  const periodId = periodIdFor(now);
  const imageQuotaKey = `quota:images:${meterId}:${periodId}`;
  const rawUsed = await env.PRO_KV.get(imageQuotaKey);
  const usedImages = rawUsed === null ? 0 : Math.max(0, Math.floor(Number(rawUsed) || 0));
  if (usedImages >= PRO_MONTHLY_IMAGE_LIMIT) {
    return quotaExceededResponse(
      caller.quota,
      {},
      `Gestu Pro monthly image allowance (${PRO_MONTHLY_IMAGE_LIMIT} images) for ${periodId} is reached. Resets on the 1st.`,
    );
  }

  const rawBody = await request.text();
  let parsed: Record<string, unknown>;
  try {
    const json = JSON.parse(rawBody) as unknown;
    if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("not object");
    parsed = json as Record<string, unknown>;
  } catch {
    return jsonProxyError(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "Request body must be a JSON object.",
      proxyHeaders(caller.quota),
    );
  }

  const prompt = typeof parsed["prompt"] === "string" ? parsed["prompt"].trim() : "";
  if (prompt === "") {
    return jsonProxyError(
      400,
      "invalid_request_error",
      "invalid_request_error",
      "Prompt is required.",
      proxyHeaders(caller.quota),
    );
  }

  const baseUrl = (config.imageGenBaseUrl || DEFAULT_IMAGE_GEN_BASE_URL).replace(/\/+$/, "");
  let upstream: Response;
  try {
    upstream = await fetch(`${baseUrl}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${readImageGenApiKey(env)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(parsed),
    });
  } catch (err) {
    console.error(`proxy: image-gen fetch failed (${err instanceof Error ? err.name : "unknown"})`);
    return jsonProxyError(
      502,
      "gestu_upstream_unreachable",
      "upstream_unreachable",
      "Could not reach the managed image service.",
      proxyHeaders(caller.quota),
    );
  }

  if (!upstream.ok) {
    return sanitizedUpstreamFailure(upstream.status, caller);
  }

  await env.PRO_KV.put(imageQuotaKey, String(usedImages + 1));

  const headers = safeUpstreamHeaders(upstream);
  for (const [name, value] of Object.entries(proxyHeaders(caller.quota))) {
    headers.set(name, value);
  }
  headers.set("X-Gestu-Image-Quota-Used", String(usedImages + 1));
  headers.set("X-Gestu-Image-Quota-Limit", String(PRO_MONTHLY_IMAGE_LIMIT));
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
