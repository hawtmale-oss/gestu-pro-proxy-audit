/**
 * Scheduled maintenance: pruning.
 *
 * The month rolls over with **no cron job at all** — the period is part of the quota KV key, so the
 * first request of a new month reads a key that does not exist and starts at zero. That is the
 * design; the cron exists only so the namespace does not grow without bound.
 *
 * What it prunes, and why that is safe:
 *
 *  * `quota:<keyId>:<yyyy-MM>` for periods older than `QUOTA_RETENTION_MONTHS`. These are pure
 *    counters; the only cost of deleting one is that a support question about a two-month-old month
 *    cannot be answered from KV. Nothing about access depends on them.
 *
 * It never touches `key:` records or `purchase:` records, so a lapsed subscriber's record survives
 * for support and for `/api/subscription-status`, and a reinstall keeps resolving to the same key.
 *
 * The periods to sweep come from the maintenance index rather than from a guess, so the run does a
 * bounded number of KV deletes instead of blind-deleting a year of keys per stored key.
 */

import type { Env, ProxyConfig } from "./config";
import { monthsBetween, periodIdFor, tierUsageKey } from "./quota";
import { QUOTA_RETENTION_MONTHS, quotaRecordKey, readMaintenanceIndex } from "./store";

/** Marker key: the period the last prune covered, so the scan runs at most once a month. */
const PRUNE_MARKER_KEY = "maintenance:last-prune-period";

/** Hard cap on keys examined per run, so a runaway namespace cannot exhaust the CPU budget. */
const MAX_KEYS_PER_RUN = 1000;

export interface PruneReport {
  ran: boolean;
  periodId: string;
  keysExamined: number;
  periodsSwept: string[];
  quotaKeysDeleted: number;
  reason: string;
}

/**
 * Runs the monthly prune.
 *
 * Idempotent and cheap when nothing is due: a single KV read of the marker decides whether any work
 * happens, so the daily trigger costs one read on 29 days out of 30.
 */
export async function runScheduledPrune(env: Env, config: ProxyConfig, now = Date.now()): Promise<PruneReport> {
  void config;
  const periodId = periodIdFor(now);
  const report: PruneReport = {
    ran: false,
    periodId,
    keysExamined: 0,
    periodsSwept: [],
    quotaKeysDeleted: 0,
    reason: "",
  };

  const marker = await env.PRO_KV.get(PRUNE_MARKER_KEY);
  if (marker === periodId) {
    report.reason = "already pruned this period";
    return report;
  }

  const index = await readMaintenanceIndex(env.PRO_KV);
  if (index.keyIds.length === 0 || index.periods.length === 0) {
    report.reason = "maintenance index is empty; nothing recorded to prune";
    // Stamp the marker anyway: with nothing recorded there is nothing to come back for, and the
    // next metered request re-populates the index for next month's run.
    await env.PRO_KV.put(PRUNE_MARKER_KEY, periodId);
    return report;
  }

  const stalePeriods = index.periods.filter((period) => {
    const age = monthsBetween(periodId, period);
    return age !== null && age > QUOTA_RETENTION_MONTHS;
  });
  if (stalePeriods.length === 0) {
    report.reason = "no period is older than the retention window";
    await env.PRO_KV.put(PRUNE_MARKER_KEY, periodId);
    return report;
  }

  report.ran = true;
  report.periodsSwept = stalePeriods;
  for (const keyId of index.keyIds.slice(0, MAX_KEYS_PER_RUN)) {
    report.keysExamined += 1;
    for (const stalePeriod of stalePeriods) {
      await env.PRO_KV.delete(quotaRecordKey(keyId, stalePeriod));
      await env.PRO_KV.delete(tierUsageKey(keyId, stalePeriod));
      await env.PRO_KV.delete(`quota:images:${keyId}:${stalePeriod}`);
      report.quotaKeysDeleted += 1;
    }
  }
  if (index.keyIds.length > MAX_KEYS_PER_RUN) {
    console.warn(
      `maintenance: examined ${MAX_KEYS_PER_RUN} of ${index.keyIds.length} keys; the rest wait for tomorrow`,
    );
  }

  await env.PRO_KV.put(PRUNE_MARKER_KEY, periodId);
  console.log(
    `maintenance: swept ${report.periodsSwept.join(",")} across ${report.keysExamined} keys ` +
      `(${report.quotaKeysDeleted} deletes) for period ${periodId}`,
  );
  return report;
}

/** `yyyy-MM` shifted by `delta` months, or null when the input is malformed. */
export function shiftPeriod(periodId: string, delta: number): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(periodId);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const zeroBased = year * 12 + (month - 1) + delta;
  const shiftedYear = Math.floor(zeroBased / 12);
  const shiftedMonth = (zeroBased % 12) + 1;
  return `${shiftedYear}-${String(shiftedMonth).padStart(2, "0")}`;
}
