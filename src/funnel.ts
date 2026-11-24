/**
 * PII-free server-side funnel counters stored in Cloudflare D1 (`FUNNEL_DB`).
 *
 * Privacy guarantee:
 *   - Only 4 daily UTC aggregate integers are stored: `trial_started`, `trial_cap_hit`,
 *     `pro_activated`, `day7_active`.
 *   - Zero user IDs, zero device IDs, zero IP addresses, and zero prompt/response content are
 *     ever written to D1.
 *   - When `FUNNEL_DB` is not bound (local dev, tests, or before the operator runs the D1
 *     migration), all writes are safe no-ops so inference and provisioning never fail.
 *
 * Operator reporting:
 *   `GET /admin/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=json|csv]`
 *   Authenticated with the read-only `ADMIN_USAGE_SECRET` bearer token.
 */

import { verifyAdminUsageSecret } from "./admin-usage";
import type { Env } from "./config";
import { utcDayId } from "./free-global";
import { HttpError, jsonResponse } from "./responses";

export const FUNNEL_METRICS = [
  "trial_started",
  "trial_cap_hit",
  "pro_activated",
  "day7_active",
] as const;

export type FunnelMetric = (typeof FUNNEL_METRICS)[number];

/**
 * Elapsed time since first-seen that qualifies a returning user for `day7_active`:
 * 6 full 24-hour periods (the start of Day 7, so a user returning on Day 7 of a 7-day trial
 * is counted before the trial expires at 7 * 24h).
 */
export const DAY7_ACTIVE_THRESHOLD_MS = 6 * 86_400_000;

/** TTL for once-per-user deduplication markers in KV (45 days). */
const FUNNEL_DEDUPE_TTL_SECONDS = 45 * 86_400;

/** `YYYY-MM-DD`, matching `utcDayId`. */
export const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export interface FunnelDayRow {
  day: string;
  trial_started: number;
  trial_cap_hit: number;
  pro_activated: number;
  day7_active: number;
}

export interface FunnelTotals {
  trial_started: number;
  trial_cap_hit: number;
  pro_activated: number;
  day7_active: number;
}

export interface FunnelStatsReport {
  from: string;
  to: string;
  totals: FunnelTotals;
  days: FunnelDayRow[];
}

export function hasFunnelDb(env: Env): env is Env & { FUNNEL_DB: D1Database } {
  return Boolean(
    env.FUNNEL_DB && typeof (env.FUNNEL_DB as { prepare?: unknown }).prepare === "function",
  );
}

/**
 * Atomically increments one PII-free daily aggregate counter in D1.
 *
 * Best-effort: a D1 write failure is logged (metadata only) and never fails a user request.
 */
export async function recordFunnelEvent(
  env: Env,
  metric: FunnelMetric,
  now = Date.now(),
): Promise<boolean> {
  if (!hasFunnelDb(env)) return false;
  const day = utcDayId(now);
  try {
    await env.FUNNEL_DB.prepare(
      `INSERT INTO funnel_daily_counters (day, metric, count, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(day, metric) DO UPDATE SET
         count = count + 1,
         updated_at = excluded.updated_at`,
    )
      .bind(day, metric, now)
      .run();
    return true;
  } catch (error) {
    console.error(
      `funnel: failed to record ${metric} (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

/**
 * Increments a funnel counter at most once per opaque `dedupeId` (e.g. hashed meterId or licenceId),
 * using a short-lived KV marker so retries or repeated hits on a cap screen never double-count.
 *
 * Skips KV entirely when `FUNNEL_DB` is not bound so deployments without D1 pay zero KV cost.
 */
export async function recordFunnelEventOnce(
  env: Env,
  metric: FunnelMetric,
  dedupeId: string,
  now = Date.now(),
): Promise<boolean> {
  if (!hasFunnelDb(env) || dedupeId.trim() === "") return false;
  const markerKey = `funnel:once:${metric}:${dedupeId}`;
  try {
    const existing = await env.PRO_KV.get(markerKey);
    if (existing !== null) return false;
    const recorded = await recordFunnelEvent(env, metric, now);
    if (recorded) {
      await env.PRO_KV.put(markerKey, "1", { expirationTtl: FUNNEL_DEDUPE_TTL_SECONDS });
    }
    return recorded;
  } catch (error) {
    console.error(
      `funnel: dedupe check failed for ${metric} (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

/** Queries daily aggregate funnel counters from D1 over `[from, to]` (inclusive UTC dates). */
export async function queryFunnelStats(
  env: Env,
  options: { from?: string; to?: string; now?: number } = {},
): Promise<FunnelStatsReport> {
  const now = options.now ?? Date.now();
  const to = options.to ?? utcDayId(now);
  const from = options.from ?? utcDayId(now - 29 * 86_400_000);

  const totals: FunnelTotals = {
    trial_started: 0,
    trial_cap_hit: 0,
    pro_activated: 0,
    day7_active: 0,
  };

  if (!hasFunnelDb(env)) {
    return { from, to, totals, days: [] };
  }

  const result = await env.FUNNEL_DB.prepare(
    `SELECT day, metric, count
     FROM funnel_daily_counters
     WHERE day >= ? AND day <= ?
     ORDER BY day ASC, metric ASC`,
  )
    .bind(from, to)
    .all<{ day: string; metric: string; count: number }>();

  const byDay = new Map<string, FunnelDayRow>();
  for (const row of result.results ?? []) {
    const day = String(row.day ?? "");
    const metric = String(row.metric ?? "") as FunnelMetric;
    const count =
      typeof row.count === "number" && Number.isFinite(row.count) && row.count > 0
        ? Math.trunc(row.count)
        : 0;
    if (!DAY_PATTERN.test(day) || !(FUNNEL_METRICS as readonly string[]).includes(metric)) {
      continue;
    }
    let entry = byDay.get(day);
    if (!entry) {
      entry = {
        day,
        trial_started: 0,
        trial_cap_hit: 0,
        pro_activated: 0,
        day7_active: 0,
      };
      byDay.set(day, entry);
    }
    entry[metric] += count;
    totals[metric] += count;
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return { from, to, totals, days };
}

export function toFunnelCsv(days: readonly FunnelDayRow[]): string {
  const lines = ["day,trial_started,trial_cap_hit,pro_activated,day7_active"];
  for (const row of days) {
    lines.push(
      `${row.day},${row.trial_started},${row.trial_cap_hit},${row.pro_activated},${row.day7_active}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * `GET /admin/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=json|csv]`
 *
 * Operator-only read endpoint for the 4 PII-free funnel counters.
 */
export async function handleAdminFunnel(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  await verifyAdminUsageSecret(request, env);

  if (!hasFunnelDb(env)) {
    throw new HttpError(
      503,
      { ok: false, error: "server_misconfigured", message: "FUNNEL_DB is not bound." },
      "admin funnel: FUNNEL_DB is not bound",
    );
  }

  const url = new URL(request.url);
  const to = url.searchParams.get("to") ?? utcDayId(now);
  const from = url.searchParams.get("from") ?? utcDayId(now - 29 * 86_400_000);
  if (!DAY_PATTERN.test(from) || !DAY_PATTERN.test(to)) {
    throw new HttpError(
      400,
      { ok: false, error: "invalid_request", message: "from and to must be formatted YYYY-MM-DD." },
      "admin funnel: invalid date range",
    );
  }
  if (from > to) {
    throw new HttpError(
      400,
      { ok: false, error: "invalid_request", message: "from must be on or before to." },
      "admin funnel: from > to",
    );
  }

  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    throw new HttpError(
      400,
      { ok: false, error: "invalid_request", message: "format must be json or csv." },
      "admin funnel: invalid format",
    );
  }

  const report = await queryFunnelStats(env, { from, to, now });
  if (format === "csv") {
    return new Response(toFunnelCsv(report.days), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="gestu-funnel-${from}-to-${to}.csv"`,
      },
    });
  }

  return jsonResponse({
    ok: true,
    service: "gestu-pro-proxy",
    generatedAt: new Date(now).toISOString(),
    ...report,
  });
}
