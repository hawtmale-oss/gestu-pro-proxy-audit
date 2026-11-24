/**
 * Emergency-only global Free spend abuse guardrail.
 *
 * Normal Free trial users are governed by **per-user trial limits** (7-day window or US$0.50
 * per-user cap in `LicenceMeter`), NOT by a low global cap — so 200–350 daily testers can never
 * lock out new signups with a `503 free_capacity_reached` error.
 *
 * This module exists strictly as a high emergency backstop against a distributed bot-farm attack
 * cycling thousands of fresh device IDs in a single UTC day. The default is US$500/day (20× the
 * retired $25/day circuit breaker) and is configurable via `GESTU_FREE_EMERGENCY_DAILY_CAP_USD`
 * (or set to `"0"` / `"off"` to disable). Pro traffic is never affected.
 *
 * The counter lives in one named `LicenceMeter` Durable Object so every edge location sees the
 * same number. A failure to reach it lets the request through and logs: per-user trial limits
 * still apply, and a meter outage must not take the Free tier down.
 */

import type { Env } from "./config";
import { callLicenceMeter, hasLiveLicenceMeter } from "./licence-meter";

export const FREE_GLOBAL_SPEND_METER_ID = "global:free-spend";
/**
 * Default emergency-only abuse guardrail across all Free traffic per UTC day: US$500.00.
 * Sized so 200–350 legitimate daily trial testers never trip it; only catastrophic distributed
 * abuse can reach this ceiling.
 */
export const DEFAULT_FREE_EMERGENCY_DAILY_CAP_MICRO_USD = 500_000_000;
/** Backwards-compatible alias for `DEFAULT_FREE_EMERGENCY_DAILY_CAP_MICRO_USD`. */
export const DEFAULT_FREE_GLOBAL_DAILY_CAP_MICRO_USD = DEFAULT_FREE_EMERGENCY_DAILY_CAP_MICRO_USD;

export function utcDayId(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/**
 * Resolves the emergency daily Free spend guardrail in micro-USD.
 *
 * Precedence: `GESTU_FREE_EMERGENCY_DAILY_CAP_USD` -> legacy `GESTU_FREE_GLOBAL_DAILY_CAP_USD` ->
 * `DEFAULT_FREE_EMERGENCY_DAILY_CAP_MICRO_USD` ($500/day).
 *
 * Returning `0` disables the emergency guardrail (triggered explicitly by `"0"` or `"off"`).
 * Any other non-positive or unparseable value falls back to the safe default.
 */
export function freeGlobalDailyCapMicroUsd(env: Env): number {
  const bag = env as unknown as Record<string, string | undefined>;
  const rawString = (
    bag["GESTU_FREE_EMERGENCY_DAILY_CAP_USD"] ??
    bag["GESTU_FREE_GLOBAL_DAILY_CAP_USD"] ??
    ""
  ).trim();
  if (rawString === "") return DEFAULT_FREE_EMERGENCY_DAILY_CAP_MICRO_USD;
  if (rawString === "0" || rawString.toLowerCase() === "off") return 0;
  const parsed = Number.parseFloat(rawString);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.round(parsed * 1_000_000)
    : DEFAULT_FREE_EMERGENCY_DAILY_CAP_MICRO_USD;
}

export async function isFreeGlobalCapReached(env: Env, now: number): Promise<boolean> {
  const cap = freeGlobalDailyCapMicroUsd(env);
  if (cap <= 0 || !hasLiveLicenceMeter(env)) return false;
  try {
    const spent = await callLicenceMeter<number>(env.LICENCE_METER, FREE_GLOBAL_SPEND_METER_ID, "getGlobalSpend", {
      dayId: utcDayId(now),
    });
    return spent >= cap;
  } catch (error) {
    console.error(`free-global: spend check failed (${error instanceof Error ? error.message : String(error)}) — allowing`);
    return false;
  }
}

export async function recordFreeGlobalSpend(env: Env, costMicroUsd: number, now: number): Promise<void> {
  if (!hasLiveLicenceMeter(env) || !(costMicroUsd > 0)) return;
  try {
    await callLicenceMeter(env.LICENCE_METER, FREE_GLOBAL_SPEND_METER_ID, "addGlobalSpend", {
      dayId: utcDayId(now),
      costMicroUsd,
    });
  } catch (error) {
    console.error(`free-global: spend record failed (${error instanceof Error ? error.message : String(error)})`);
  }
}
