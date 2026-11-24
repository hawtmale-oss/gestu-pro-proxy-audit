/**
 * Cost-weighted token metering in micro-USD (µUSD).
 *
 * 1 USD = 1,000,000 µUSD.
 * Because 1M tokens = 1,000,000 tokens, a price quoted in "USD per 1M tokens"
 * is numerically identical to "µUSD per single token".
 *
 * Example (DeepSeek V4.1 Flash reference rates):
 *   Off-peak: cache hit $0.003/1M, cache miss $0.150/1M, output $0.600/1M
 *   Peak:     cache hit $0.006/1M, cache miss $0.300/1M, output $1.200/1M
 *
 * Peak hours: Monday–Friday, 01:00–04:00 UTC and 06:00–10:00 UTC.
 */

import { normalizeTokenCount } from "./quota";

export const PPM_LIMIT = 1_000_000;
/**
 * Default monthly soft cap in micro-USD for licence-backed keys (consumer Pro tier).
 *
 * $10.00 sits comfortably below the $14.99/mo list price: the locked Pro token allowances
 * (1,500,000 output + 100,000,000 input) can consume more than the subscription price at list
 * rates, so reduced mode starts at $10.00 and the 150% hard cap ($15.00) bounds the worst case.
 * Deployment override: `GESTU_MONTHLY_CAP_MICRO_USD` (wrangler.toml sets the same number).
 */
export const DEFAULT_FREE_MONTHLY_CAP_MICRO_USD = 500_000; // US$0.50 per-user Free trial cap
export const DEFAULT_SOFT_CAP_MICRO_USD = 10_000_000; // US$10.00 / month
export const DEFAULT_BUSINESS_SOFT_CAP_MICRO_USD = 160_000_000; // US$160.00 / month
export const DEFAULT_HARD_CAP_MULTIPLIER = 1.5; // 150% of soft cap -> $15.00/mo

export interface RateCard {
  /** USD per 1M cache-hit input tokens (= µUSD per token). */
  cacheHit: number;
  /** USD per 1M cache-miss input tokens (= µUSD per token). */
  cacheMiss: number;
  /** USD per 1M completion/output tokens (= µUSD per token). */
  output: number;
}

export interface ModelPriceSchedule {
  offPeak: RateCard;
  peak: RateCard;
}

export type PriceTable = Record<string, ModelPriceSchedule>;

export interface DetailedUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export const DEFAULT_MODEL_SCHEDULE: ModelPriceSchedule = {
  offPeak: {
    cacheHit: 0.003,
    cacheMiss: 0.15,
    output: 0.6,
  },
  peak: {
    cacheHit: 0.006,
    cacheMiss: 0.3,
    output: 1.2,
  },
};

export const DEFAULT_PRICE_TABLE: PriceTable = {
  default: DEFAULT_MODEL_SCHEDULE,
  "deepseek-flash": DEFAULT_MODEL_SCHEDULE,
  "gestu-pro-flash": DEFAULT_MODEL_SCHEDULE,
};

/**
 * Peak is UTC Monday to Friday (getUTCDay() 1..5), hours 01:00–04:00 (1, 2, 3)
 * and 06:00–10:00 (6, 7, 8, 9).
 */
export function isPeakHourUtc(epochMs: number): boolean {
  const date = new Date(epochMs);
  const day = date.getUTCDay();
  if (day < 1 || day > 5) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function parseRateCard(raw: unknown, fallback: RateCard): RateCard {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const obj = raw as Record<string, unknown>;
  const cacheHit = Number(obj["cacheHit"] ?? obj["cache_hit"] ?? fallback.cacheHit);
  const cacheMiss = Number(obj["cacheMiss"] ?? obj["cache_miss"] ?? fallback.cacheMiss);
  const output = Number(obj["output"] ?? fallback.output);
  return {
    cacheHit: Number.isFinite(cacheHit) && cacheHit >= 0 ? cacheHit : fallback.cacheHit,
    cacheMiss: Number.isFinite(cacheMiss) && cacheMiss >= 0 ? cacheMiss : fallback.cacheMiss,
    output: Number.isFinite(output) && output >= 0 ? output : fallback.output,
  };
}

function parseSchedule(raw: unknown, fallback: ModelPriceSchedule): ModelPriceSchedule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const obj = raw as Record<string, unknown>;
  if ("offPeak" in obj || "off_peak" in obj || "peak" in obj) {
    const offPeak = parseRateCard(obj["offPeak"] ?? obj["off_peak"], fallback.offPeak);
    const peak = parseRateCard(obj["peak"] ?? obj["offPeak"] ?? obj["off_peak"], offPeak);
    return { offPeak, peak };
  }
  // Flat rate card (same rates for peak and off-peak, e.g. managed cloud MaaS)
  const flat = parseRateCard(obj, fallback.offPeak);
  return { offPeak: flat, peak: flat };
}

/**
 * Parses `GESTU_PRICE_TABLE` JSON string into a normalized PriceTable.
 * Falls back to `DEFAULT_PRICE_TABLE` on empty or malformed JSON.
 */
export function parsePriceTable(rawJson: string | undefined): PriceTable {
  if (!rawJson || rawJson.trim() === "") {
    return DEFAULT_PRICE_TABLE;
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("cost: GESTU_PRICE_TABLE is not a JSON object; using default price table");
      return DEFAULT_PRICE_TABLE;
    }
    const record = parsed as Record<string, unknown>;
    // If top-level object is itself a single schedule or rate card:
    if ("offPeak" in record || "off_peak" in record || "cacheMiss" in record || "cache_miss" in record) {
      const schedule = parseSchedule(record, DEFAULT_MODEL_SCHEDULE);
      return {
        default: schedule,
        "deepseek-flash": schedule,
        "gestu-pro-flash": schedule,
      };
    }
    const table: PriceTable = { ...DEFAULT_PRICE_TABLE };
    for (const [key, value] of Object.entries(record)) {
      table[key] = parseSchedule(value, DEFAULT_MODEL_SCHEDULE);
    }
    return table;
  } catch (err) {
    console.error(`cost: failed to parse GESTU_PRICE_TABLE (${err instanceof Error ? err.message : String(err)})`);
    return DEFAULT_PRICE_TABLE;
  }
}

/**
 * Normalizes an OpenAI/DeepSeek `usage` object into cache-hit, cache-miss, and completion tokens.
 *
 * - Cache-hit tokens: `prompt_cache_hit_tokens`, falling back to `prompt_tokens_details.cached_tokens`.
 * - Cache-miss tokens: `prompt_cache_miss_tokens`, falling back to `prompt_tokens - cacheHitTokens`.
 * - Output tokens: `completion_tokens`.
 */
export function extractDetailedUsage(rawUsage: unknown): DetailedUsage {
  if (rawUsage === null || typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 };
  }
  const u = rawUsage as Record<string, unknown>;
  const rawPrompt = normalizeTokenCount(u["prompt_tokens"]);
  const completionTokens = normalizeTokenCount(u["completion_tokens"]);

  const details =
    u["prompt_tokens_details"] !== null && typeof u["prompt_tokens_details"] === "object"
      ? (u["prompt_tokens_details"] as Record<string, unknown>)
      : null;

  const explicitHit =
    u["prompt_cache_hit_tokens"] !== undefined
      ? normalizeTokenCount(u["prompt_cache_hit_tokens"])
      : details && details["cached_tokens"] !== undefined
        ? normalizeTokenCount(details["cached_tokens"])
        : 0;

  const explicitMiss =
    u["prompt_cache_miss_tokens"] !== undefined
      ? normalizeTokenCount(u["prompt_cache_miss_tokens"])
      : null;

  const promptTokens = Math.max(rawPrompt, explicitHit + (explicitMiss ?? 0));
  const cacheHitTokens = Math.min(promptTokens, explicitHit);
  const cacheMissTokens =
    explicitMiss !== null ? explicitMiss : Math.max(0, promptTokens - cacheHitTokens);

  return {
    promptTokens: cacheHitTokens + cacheMissTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens,
  };
}

/**
 * Computes the cost of a request in integer micro-USD (µUSD).
 */
export function calculateCostMicroUsd(input: {
  usage: DetailedUsage;
  model?: string;
  upstreamHost?: string;
  priceTable: PriceTable;
  now: number;
}): number {
  const { usage, model, upstreamHost, priceTable, now } = input;
  if (
    usage.cacheHitTokens <= 0 &&
    usage.cacheMissTokens <= 0 &&
    usage.completionTokens <= 0
  ) {
    return 0;
  }

  const schedule =
    (upstreamHost && priceTable[upstreamHost]) ||
    (model && priceTable[model]) ||
    priceTable["default"] ||
    DEFAULT_MODEL_SCHEDULE;

  const rates = isPeakHourUtc(now) ? schedule.peak : schedule.offPeak;
  const microUsdFloat =
    usage.cacheHitTokens * rates.cacheHit +
    usage.cacheMissTokens * rates.cacheMiss +
    usage.completionTokens * rates.output;

  if (microUsdFloat <= 0) return 0;
  return Math.max(1, Math.ceil(microUsdFloat));
}

/**
 * Estimates token usage when an upstream stream terminates before emitting a final `usage` chunk.
 * Uses a conservative ~4 UTF-8 bytes per token heuristic so interrupted streams never cost zero.
 */
export function estimateFallbackUsage(requestBytes: number, responseBytes: number): DetailedUsage {
  const promptTokens = Math.max(1, Math.ceil(Math.max(0, requestBytes) / 4));
  const completionTokens = Math.max(1, Math.ceil(Math.max(0, responseBytes) / 4));
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens: 0,
    cacheMissTokens: promptTokens,
  };
}

/**
 * Converts micro-USD spend into parts per million (ppm) of the monthly soft cap.
 * Soft cap = 1,000,000 ppm. Values above 1,000,000 indicate reduced mode (up to hard cap).
 */
export function microUsdToPpm(usedMicroUsd: number, softCapMicroUsd: number): number {
  if (softCapMicroUsd <= 0 || usedMicroUsd <= 0) return 0;
  return Math.max(0, Math.floor((usedMicroUsd / softCapMicroUsd) * PPM_LIMIT));
}
