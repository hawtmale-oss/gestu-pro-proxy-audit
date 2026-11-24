/**
 * Billing-period arithmetic and quota accounting. Pure functions; the KV write that persists the
 * result lives in `store.ts`.
 *
 * The period is a UTC calendar month, `yyyy-MM`, and it is *part of the KV key*. That is what
 * makes the month roll over with no cron job: the first request of a new month reads a key that
 * does not exist yet, which is zero.
 */

import type { PlanTier, SubscriptionStatusId } from "./constants";
import {
  FREE_MAX_COMPLETION_TOKENS,
  FREE_MAX_INPUT_TOKENS,
  FREE_MAX_REQUEST_TOKENS,
  FREE_MONTHLY_INPUT_TOKENS,
  FREE_MONTHLY_OUTPUT_TOKENS,
  FREE_MONTHLY_TOTAL_TOKENS,
  MAX_COMPLETION_TOKENS,
  PAID_MAX_INPUT_TOKENS,
  PAID_MAX_REQUEST_TOKENS,
  PLAN_FREE,
  PRO_MONTHLY_INPUT_TOKENS,
  PRO_MONTHLY_OUTPUT_TOKENS,
  PRODUCT_ID_BUSINESS,
  PRODUCT_ID_FREE,
  REDUCED_MODE_MAX_TOKENS,
  STATUS,
  tierForProductId,
} from "./constants";
import { rememberPeriod } from "./store";

/** `yyyy-MM` for the UTC month containing `epochMs`. */
export function periodIdFor(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * Epoch millis at which the period containing `epochMs` ends — 00:00:00.000 UTC on the first day
 * of the next month. `Date.UTC` normalises month 12 into January of the next year, which is why
 * this needs no December special case.
 */
export function periodRenewsAt(epochMs: number): number {
  const date = new Date(epochMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/** Whole months between two `yyyy-MM` ids (`a - b`), or `null` when either is malformed. */
export function monthsBetween(a: string, b: string): number | null {
  const left = parsePeriod(a);
  const right = parsePeriod(b);
  if (left === null || right === null) return null;
  return (left.year - right.year) * 12 + (left.month - right.month);
}

function parsePeriod(period: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** The state of one key's budget for one period. */
export interface QuotaSnapshot {
  periodId: string;
  usedTokens: number;
  limitTokens: number;
  renewsAt: number;
}

/**
 * Everything the 429 gate and the `X-Gestu-Quota-*` headers need, computed without touching KV.
 *
 * `used >= limit` is the exhaustion test, matching the app's own
 * `QuotaStatus.isExhausted` (`usedTokens >= limitTokens`), so a request that lands exactly on
 * the limit is refused rather than allowed to overshoot.
 */
export function quotaSnapshot(input: {
  periodId: string;
  usedTokens: number;
  limitTokens: number;
  renewsAt: number;
}): QuotaSnapshot {
  return {
    periodId: input.periodId,
    usedTokens: Math.max(0, Math.trunc(input.usedTokens)),
    limitTokens: Math.max(0, Math.trunc(input.limitTokens)),
    renewsAt: input.renewsAt,
  };
}

export function isExhausted(quota: QuotaSnapshot): boolean {
  return quota.limitTokens > 0 && quota.usedTokens >= quota.limitTokens;
}

export function remainingTokens(quota: QuotaSnapshot): number {
  return Math.max(0, quota.limitTokens - quota.usedTokens);
}

/** Adds usage to a snapshot. The proxy is the only writer; the app only mirrors. */
export function addUsage(quota: QuotaSnapshot, promptTokens: number, completionTokens: number): QuotaSnapshot {
  return quotaSnapshot({
    periodId: quota.periodId,
    usedTokens: quota.usedTokens + normalizeTokenCount(promptTokens) + normalizeTokenCount(completionTokens),
    limitTokens: quota.limitTokens,
    renewsAt: quota.renewsAt,
  });
}

/**
 * Coerces a provider-reported count to a non-negative integer.
 *
 * A `NaN` or negative count from upstream would otherwise poison the counter for the rest of the
 * month, so it is clamped to 0 rather than stored.
 */
export function normalizeTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Whether the subscription grant behind a key still permits traffic.
 *
 * Single decision point shared by the proxy gate, `/api/subscription-status`, and the RTDN
 * handler, so "allowed" cannot mean two different things in two places. `grace` counts as
 * allowed — Google is still retrying the card and the user has paid for the period they are in.
 *
 * `canceled` is allowed **while the paid period has not ended**: that is exactly what Play's own
 * `SUBSCRIPTION_STATE_CANCELED` means ("canceled but not expired yet — all items have
 * auto-renew set to false"), and it matches `isEntitledNow` in `play.ts`. Refusing it here made a
 * freshly provisioned, cancelled-but-paid key fail every request after the key had been minted.
 */
export function isGrantActive(status: SubscriptionStatusId, expiresAt: number, now: number): boolean {
  if (status !== STATUS.ACTIVE && status !== STATUS.GRACE && status !== STATUS.CANCELED) return false;
  if (expiresAt > 0 && expiresAt <= now) return false;
  return true;
}

/**
 * The monthly combined-token ceiling that applies to one key.
 *
 * Free keys carry their own combined ceiling (the 200,000-output promise plus the Free input cost
 * control); a business licence is a single key shared by every device in a company, so it carries
 * its own, much larger allowance; everything else uses the deployment's Pro ceiling. Resolving it
 * in one place is what stops the proxy gate, `/api/subscription-status` and the
 * `X-Gestu-Quota-*` headers from disagreeing.
 *
 * Takes the two deployment numbers rather than the whole config so this stays a pure function and
 * the choice can be tested without a deployment.
 */
export function tokenLimitFor(
  productId: string,
  limits: { monthlyTokenLimit: number; businessMonthlyTokenLimit: number },
): number {
  if (productId === PRODUCT_ID_BUSINESS) return limits.businessMonthlyTokenLimit;
  if (productId === PRODUCT_ID_FREE || productId === PLAN_FREE) return FREE_MONTHLY_TOTAL_TOKENS;
  return limits.monthlyTokenLimit;
}

/** Monthly output token billing cap for a plan tier or product id. */
export function monthlyOutputTokenLimitFor(tierOrProductId: PlanTier | string | undefined | null): number {
  if (tierOrProductId === PRODUCT_ID_BUSINESS) {
    return PRO_MONTHLY_OUTPUT_TOKENS * 10;
  }
  return tierForProductId(tierOrProductId) === PLAN_FREE
    ? FREE_MONTHLY_OUTPUT_TOKENS
    : PRO_MONTHLY_OUTPUT_TOKENS;
}

/** Monthly input token cost-control cap for a plan tier or product id. */
export function monthlyInputTokenLimitFor(tierOrProductId: PlanTier | string | undefined | null): number {
  if (tierOrProductId === PRODUCT_ID_BUSINESS) {
    return PRO_MONTHLY_INPUT_TOKENS * 10;
  }
  return tierForProductId(tierOrProductId) === PLAN_FREE
    ? FREE_MONTHLY_INPUT_TOKENS
    : PRO_MONTHLY_INPUT_TOKENS;
}

/** Human-facing tier label used in refusal messages. Never names an upstream provider. */
export function tierLabel(tier: PlanTier): string {
  return tier === PLAN_FREE ? "Gestu Free" : "Gestu Pro";
}

/** Maximum combined estimated input + requested completion tokens per request. */
export function maxRequestTokensFor(tier: PlanTier): number {
  return tier === "free" ? FREE_MAX_REQUEST_TOKENS : PAID_MAX_REQUEST_TOKENS;
}

/** Maximum estimated input tokens per request. */
export function maxInputTokensFor(tier: PlanTier): number {
  return tier === "free" ? FREE_MAX_INPUT_TOKENS : PAID_MAX_INPUT_TOKENS;
}

/** Maximum completion tokens permitted in normal mode for a tier. */
export function maxCompletionTokensFor(tier: PlanTier): number {
  return tier === "free" ? FREE_MAX_COMPLETION_TOKENS : MAX_COMPLETION_TOKENS;
}

/**
 * The completion-token ceiling that applies to one request: reduced mode caps first, then the
 * tier's normal ceiling.
 *
 * The proxy uses this single number twice — for the pre-flight budget estimate *and* for the
 * outbound body — so a hostile `max_tokens: 10_000_000` cannot fail the request budget check while
 * the clamped body would have passed it, and cannot slip past the clamp either.
 */
export function requestCompletionCapFor(tier: PlanTier, mode: "normal" | "reduced" = "normal"): number {
  return mode === "reduced" ? REDUCED_MODE_MAX_TOKENS : maxCompletionTokensFor(tier);
}

export interface TierTokenUsage {
  periodId: string;
  inputTokens: number;
  outputTokens: number;
}

export type TierCapCheckResult =
  | {
      allowed: true;
      tier: PlanTier;
      outputLimit: number;
      inputLimit: number;
    }
  | {
      allowed: false;
      tier: PlanTier;
      reason: "output_cap_exceeded" | "input_cap_exceeded";
      outputLimit: number;
      inputLimit: number;
      message: string;
    };

/**
 * Checks whether a caller has exhausted either their monthly output billing cap or monthly input
 * cost-control cap.
 */
export function checkTierTokenCaps(
  usage: { inputTokens: number; outputTokens: number },
  tierOrProductId: PlanTier | string | undefined | null,
  periodId: string,
): TierCapCheckResult {
  const tier = tierForProductId(tierOrProductId);
  const outputLimit = monthlyOutputTokenLimitFor(tierOrProductId);
  const inputLimit = monthlyInputTokenLimitFor(tierOrProductId);
  const outputTokens = normalizeTokenCount(usage.outputTokens);
  const inputTokens = normalizeTokenCount(usage.inputTokens);
  const label = tierLabel(tier);

  if (outputLimit > 0 && outputTokens >= outputLimit) {
    return {
      allowed: false,
      tier,
      reason: "output_cap_exceeded",
      outputLimit,
      inputLimit,
      message:
        tier === PLAN_FREE
          ? `${label} monthly usage allowance for ${periodId} is reached. The allowance resets on the 1st.`
          : `${label} monthly output token allowance for ${periodId} is reached ` +
            `(${outputTokens} of ${outputLimit} output tokens). The allowance resets on the 1st.`,
    };
  }
  if (inputLimit > 0 && inputTokens >= inputLimit) {
    return {
      allowed: false,
      tier,
      reason: "input_cap_exceeded",
      outputLimit,
      inputLimit,
      message:
        tier === PLAN_FREE
          ? `${label} monthly usage allowance for ${periodId} is reached. The allowance resets on the 1st.`
          : `${label} monthly input token cap for ${periodId} is reached ` +
            `(${inputTokens} of ${inputLimit} input tokens). The allowance resets on the 1st.`,
    };
  }
  return { allowed: true, tier, outputLimit, inputLimit };
}

export function tierUsageKey(keyId: string, periodId: string): string {
  return `quota:tier:${keyId}:${periodId}`;
}

const tierWriteChains = new Map<string, Promise<unknown>>();

/** Reads split input/output token counters for a KV-backed key in the current UTC month. */
export async function readTierUsage(kv: KVNamespace, keyId: string, now: number): Promise<TierTokenUsage> {
  const periodId = periodIdFor(now);
  const merged = await kv.get(quotaKey(keyId, periodId));
  if (merged !== null) {
    try {
      const parsed = JSON.parse(merged) as Partial<TierTokenUsage>;
      if (parsed.inputTokens !== undefined || parsed.outputTokens !== undefined) {
        return {
          periodId,
          inputTokens: normalizeTokenCount(parsed.inputTokens),
          outputTokens: normalizeTokenCount(parsed.outputTokens),
        };
      }
    } catch {
      // Fall through to the legacy record rather than losing the month.
    }
  }
  // Legacy months wrote the split into its own key. Reading it keeps an in-flight month intact
  // across this change instead of making every device look unused again.
  const raw = await kv.get(tierUsageKey(keyId, periodId));
  if (raw === null) return { periodId, inputTokens: 0, outputTokens: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<TierTokenUsage>;
    return {
      periodId,
      inputTokens: normalizeTokenCount(parsed.inputTokens),
      outputTokens: normalizeTokenCount(parsed.outputTokens),
    };
  } catch {
    return { periodId, inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * The single monthly writer: adds this request's split **and** the combined total to one record.
 *
 * It used to be two functions writing two keys (`quota:` and `quota:tier:`), which meant two KV
 * writes per request — on the free plan the write allowance is the scarce resource, so the split
 * and the total now share the record that `readQuota` already reads.
 */
export async function recordTierUsage(
  kv: KVNamespace,
  keyId: string,
  promptTokens: number,
  completionTokens: number,
  now: number,
): Promise<TierTokenUsage> {
  const periodId = periodIdFor(now);
  const inputDelta = normalizeTokenCount(promptTokens);
  const outputDelta = normalizeTokenCount(completionTokens);
  if (inputDelta === 0 && outputDelta === 0) {
    return readTierUsage(kv, keyId, now);
  }

  const lockKey = quotaKey(keyId, periodId);
  const previous = tierWriteChains.get(lockKey) ?? Promise.resolve();
  const task = previous.then(async (): Promise<TierTokenUsage> => {
    let prior: Record<string, unknown> = {};
    const raw = await kv.get(lockKey);
    if (raw !== null) {
      try {
        prior = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        prior = {};
      }
    }
    const inputTokens = normalizeTokenCount(prior["inputTokens"]) + inputDelta;
    const outputTokens = normalizeTokenCount(prior["outputTokens"]) + outputDelta;
    const usedTokens = normalizeTokenCount(prior["usedTokens"]) + inputDelta + outputDelta;
    const renewsAt =
      typeof prior["renewsAt"] === "number" && (prior["renewsAt"] as number) > 0
        ? (prior["renewsAt"] as number)
        : periodRenewsAt(now);
    await kv.put(
      lockKey,
      JSON.stringify({
        keyId,
        periodId,
        usedTokens,
        // `readQuota` overrides this with the live plan value, so a stored 0 is safe.
        limitTokens: typeof prior["limitTokens"] === "number" ? prior["limitTokens"] : 0,
        renewsAt,
        inputTokens,
        outputTokens,
        updatedAt: now,
      }),
    );
    await rememberPeriod(kv, periodId);
    return { periodId, inputTokens, outputTokens };
  });

  tierWriteChains.set(
    lockKey,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

/** The `quota:` record key. Kept here as a template literal to avoid a store<->quota import cycle. */
function quotaKey(keyId: string, periodId: string): string {
  return `quota:${keyId}:${periodId}`;
}
