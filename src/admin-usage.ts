/**
 * Operator-only usage reporting for the managed tiers.
 *
 * `GET /admin/usage?period=YYYY-MM[&format=json|csv][&meter=<meterId>]`
 *
 * Reads the per-meter split counters straight from KV (`quota:tier:<meterId>:<periodId>`, written
 * by `recordTierUsage`) and enriches each row with the authoritative `LicenceMeter` figures —
 * µUSD spend, request count, quota mode — when the Durable Object is bound.
 *
 * The join is by *name*, not by a second index: for a Gestu Free device `free.ts` sets
 * `licenceId = meterId`, so the Durable Object instance that holds the spend total is the one
 * named by the same string that appears in the KV key. Licensed Pro keys are named by their
 * `licenceId`, which is likewise the meter the quota keys use.
 *
 * Auth is a constant-time compare against `ADMIN_USAGE_SECRET`. This is deliberately *not*
 * `entitlement-service`'s `ADMIN_SECRET`: this endpoint only reads counters, and leaking the
 * reporting secret must not also grant the ability to grant or revoke licences.
 *
 * Nothing here is client-facing. The response carries no virtual keys and no purchase tokens —
 * only meter ids (already digests for Free devices) and integer counters — so it is safe to paste
 * into a support thread.
 */

import type { Env } from "./config";
import type { LicenceUsageSummary } from "./licence-meter";
import { callLicenceMeter, hasLiveLicenceMeter } from "./licence-meter";
import { periodIdFor } from "./quota";
import { HttpError, jsonResponse } from "./responses";

/** `YYYY-MM`, matching `periodIdFor`. */
export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Upper bound on meters summarised in one call, so a runaway namespace cannot time the Worker out. */
const MAX_METERS = 1000;

/** Bounded fan-out when enriching rows from the Durable Object. */
const ENRICH_CONCURRENCY = 8;

const TIER_PREFIX = "quota:tier:";

export interface AdminUsageRow {
  meterId: string;
  /** Derived from the meter id prefix, not from the Durable Object, so it is always trustworthy. */
  kind: MeterKind;
  periodId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Authoritative µUSD spend for the month, or null when no Durable Object is bound. */
  usedMicroUsd: number | null;
  usedPpm: number | null;
  limitPpm: number | null;
  requestCount: number | null;
  /**
   * Quota mode from the Durable Object.
   *
   * `tier` is only filled once the object has recorded activity. A `LicenceMeter` created before
   * the Free tier existed holds an empty `plan`, and `tierForProductId("")` defaults to Pro — so
   * trusting it unconditionally labels legacy Free devices as Pro.
   */
  mode: string | null;
  tier: string | null;
}

/** Meter families, distinguished by key prefix (`free.ts` uses `free-device:`; licences `lic_`). */
export type MeterKind = "free" | "licence" | "other";

export function kindForMeter(meterId: string): MeterKind {
  if (meterId.startsWith("free-device:")) return "free";
  if (meterId.startsWith("lic_")) return "licence";
  return "other";
}

export interface AdminUsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usedMicroUsd: number;
  requestCount: number;
}

/**
 * Compares two strings in a way that does not depend on where they first differ.
 *
 * Both sides are hashed first, so the comparison runs in constant time over equal-length digests
 * and leaks neither the length nor the position of the first mismatched byte of the expected
 * secret through response timing.
 */
export async function constantTimeEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let diff = 0;
  // `noUncheckedIndexedAccess` is on, so index with a fallback: the arrays are equal length by
  // construction (both are SHA-256 digests), and 0 is a safe stand-in for an impossible read.
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Fails closed when the secret is unset: an unconfigured deployment must not expose usage totals
 * to anyone, and must say so rather than 401 as though a wrong password had been supplied.
 */
export async function verifyAdminUsageSecret(request: Request, env: Env): Promise<void> {
  const expected = env.ADMIN_USAGE_SECRET;
  if (expected === undefined || expected.trim() === "") {
    throw new HttpError(
      503,
      { ok: false, error: "server_misconfigured", message: "ADMIN_USAGE_SECRET is not configured." },
      "admin usage: ADMIN_USAGE_SECRET is not set",
    );
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = match?.[1]?.trim() ?? "";
  if (provided === "" || !(await constantTimeEqual(provided, expected))) {
    throw new HttpError(
      401,
      { ok: false, error: "unauthorized", message: "A valid admin credential is required." },
      "admin usage: credential rejected",
    );
  }
}

/** Non-negative integer, defaulting to 0 for anything malformed. */
function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Lists every meter that has a split counter for `periodId`.
 *
 * KV `list` cannot filter on a suffix, so the whole `quota:tier:` space is paged and filtered
 * here. The namespace holds at most a few months of meters (pruned by the daily cron), so this is
 * a bounded scan rather than an unbounded one.
 */
export async function listMetersForPeriod(
  kv: KVNamespace,
  periodId: string,
): Promise<{ meterIds: string[]; truncated: boolean }> {
  const suffix = `:${periodId}`;
  const meterIds: string[] = [];
  let cursor: string | undefined;
  let truncated = false;

  for (;;) {
    const page = await kv.list({ prefix: TIER_PREFIX, cursor });
    for (const key of page.keys) {
      if (!key.name.endsWith(suffix)) continue;
      const meterId = key.name.slice(TIER_PREFIX.length, key.name.length - suffix.length);
      if (meterId === "") continue;
      meterIds.push(meterId);
      if (meterIds.length >= MAX_METERS) {
        truncated = true;
        break;
      }
    }
    if (truncated || page.list_complete) break;
    cursor = page.cursor;
  }

  return { meterIds, truncated };
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Builds one report row: KV counters, plus Durable Object figures when available. */
async function buildRow(env: Env, meterId: string, periodId: string, now: number): Promise<AdminUsageRow> {
  const raw = await env.PRO_KV.get(`${TIER_PREFIX}${meterId}:${periodId}`);
  let inputTokens = 0;
  let outputTokens = 0;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { inputTokens?: unknown; outputTokens?: unknown };
      inputTokens = asCount(parsed.inputTokens);
      outputTokens = asCount(parsed.outputTokens);
    } catch {
      // A corrupt counter is reported as zero rather than failing the whole report; the DO
      // figures below, when present, are the authoritative ones anyway.
    }
  }

  const row: AdminUsageRow = {
    meterId,
    kind: kindForMeter(meterId),
    periodId,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    usedMicroUsd: null,
    usedPpm: null,
    limitPpm: null,
    requestCount: null,
    mode: null,
    tier: null,
  };

  if (!hasLiveLicenceMeter(env)) return row;

  try {
    // The DO is authoritative for spend and request count; a meter that has never made a request
    // simply returns zeros rather than throwing.
    const summary = await callLicenceMeter<LicenceUsageSummary>(env.LICENCE_METER, meterId, "getUsage", {
      periodId,
      now,
    });
    row.usedMicroUsd = asCount(summary.usedMicroUsd);
    row.usedPpm = asCount(summary.usedPpm);
    row.limitPpm = asCount(summary.limitPpm);
    row.requestCount = asCount(summary.requestCount);
    row.mode = typeof summary.mode === "string" ? summary.mode : null;
    // Only trust the object's own `tier` once it has actually recorded something: an object with
    // an empty `plan` reports Pro by default, which would mislabel a legacy Free device.
    const hasActivity = (row.requestCount ?? 0) > 0 || (row.usedMicroUsd ?? 0) > 0;
    row.tier = hasActivity && typeof summary.tier === "string" ? summary.tier : null;
    // The KV split counters are the only place input/output are recorded separately; the DO
    // tracks the same split, so prefer it when it has seen more traffic than the KV snapshot.
    const doTotal = asCount(summary.inputTokens) + asCount(summary.outputTokens);
    if (doTotal > row.totalTokens) {
      row.inputTokens = asCount(summary.inputTokens);
      row.outputTokens = asCount(summary.outputTokens);
      row.totalTokens = doTotal;
    }
  } catch {
    // Leave the DO-derived fields null: the KV view is still a truthful (if less complete) answer.
  }

  return row;
}

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: readonly AdminUsageRow[]): string {
  const header = [
    "meter_id",
    "kind",
    "period_id",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "used_micro_usd",
    "request_count",
    "mode",
    "tier",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.meterId),
        csvCell(row.kind),
        csvCell(row.periodId),
        csvCell(row.inputTokens),
        csvCell(row.outputTokens),
        csvCell(row.totalTokens),
        csvCell(row.usedMicroUsd),
        csvCell(row.requestCount),
        csvCell(row.mode),
        csvCell(row.tier),
      ].join(","),
    );
  }
  // Trailing newline keeps `>>` appends and POSIX tools happy.
  return `${lines.join("\n")}\n`;
}

export async function handleAdminUsage(request: Request, env: Env, now: number): Promise<Response> {
  await verifyAdminUsageSecret(request, env);

  const url = new URL(request.url);
  const periodId = url.searchParams.get("period") ?? periodIdFor(now);
  if (!PERIOD_PATTERN.test(periodId)) {
    throw new HttpError(
      400,
      { ok: false, error: "invalid_request", message: "period must be formatted YYYY-MM." },
      "admin usage: invalid period",
    );
  }

  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    throw new HttpError(
      400,
      { ok: false, error: "invalid_request", message: "format must be json or csv." },
      "admin usage: invalid format",
    );
  }

  const single = url.searchParams.get("meter");
  const listing = single !== null && single !== ""
    ? { meterIds: [single], truncated: false }
    : await listMetersForPeriod(env.PRO_KV, periodId);

  const rows = await mapWithConcurrency(listing.meterIds, ENRICH_CONCURRENCY, (meterId) =>
    buildRow(env, meterId, periodId, now),
  );

  // Highest consumer first: the reason to open this report is almost always "who is at the top".
  rows.sort((left, right) => right.totalTokens - left.totalTokens || left.meterId.localeCompare(right.meterId));

  const totals: AdminUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usedMicroUsd: 0,
    requestCount: 0,
  };
  for (const row of rows) {
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.totalTokens += row.totalTokens;
    totals.usedMicroUsd += row.usedMicroUsd ?? 0;
    totals.requestCount += row.requestCount ?? 0;
  }

  if (format === "csv") {
    return new Response(toCsv(rows), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="gestu-usage-${periodId}.csv"`,
      },
    });
  }

  return jsonResponse({
    ok: true,
    service: "gestu-pro-proxy",
    periodId,
    generatedAt: new Date(now).toISOString(),
    meterCount: rows.length,
    truncated: listing.truncated,
    meterLimit: MAX_METERS,
    durableObjectAvailable: hasLiveLicenceMeter(env),
    totals,
    rows,
  });
}
