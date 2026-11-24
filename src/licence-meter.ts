/**
 * `LicenceMeter` — strongly consistent per-licence Durable Object (SQLite-backed).
 *
 * One instance per `licenceId`, named via `env.LICENCE_METER.idFromName(licenceId)`.
 *
 * Responsibilities:
 *  1. Authoritative per-licence status (`active`, `grace`, `on_hold`, `canceled`, `expired`, `revoked`),
 *     `periodEnd`, `notAfter`, `monthlyCapMicroUsd` (default $10.00 = 10,000,000 µUSD) and
 *     `hardCapMicroUsd` (150% = $15.00 = 15,000,000 µUSD).
 *  2. Authoritative 2-device seat table (`deviceId -> keyId, firstSeenAt, lastSeenAt`).
 *  3. Atomic monthly spend counter in micro-USD (`µUSD`), total tokens, and request count per UTC
 *     calendar month (`yyyy-MM`), eliminating KV read-modify-write races and `kv.list()` fan-out.
 *  4. In-flight concurrency lease tracking (max 2 concurrent streams per licence, 60 s lease TTL).
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";
import type { PlanTier, SubscriptionStatusId } from "./constants";
import { DEFAULT_DEVICE_LIMIT, PLAN_FREE, STATUS, tierForProductId } from "./constants";
import {
  DEFAULT_HARD_CAP_MULTIPLIER,
  DEFAULT_FREE_MONTHLY_CAP_MICRO_USD,
  DEFAULT_SOFT_CAP_MICRO_USD,
  microUsdToPpm,
  PPM_LIMIT,
} from "./cost";
import {
  checkTierTokenCaps,
  isGrantActive,
  monthlyInputTokenLimitFor,
  monthlyOutputTokenLimitFor,
  monthsBetween,
  periodIdFor,
  periodRenewsAt,
} from "./quota";
import { QUOTA_RETENTION_MONTHS } from "./store";

export type QuotaMode = "normal" | "reduced";

export interface LicenceStateRecord {
  licenceId: string;
  status: SubscriptionStatusId;
  plan: string;
  periodEnd: number;
  notAfter: number;
  monthlyCapMicroUsd: number;
  hardCapMicroUsd: number;
  deviceLimit: number;
  updatedAt: number;
}

export interface LicenceDeviceSeat {
  deviceId: string;
  keyId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface LicenceUsageSummary {
  periodId: string;
  tier: PlanTier;
  usedMicroUsd: number;
  monthlyCapMicroUsd: number;
  hardCapMicroUsd: number;
  usedPpm: number;
  limitPpm: number;
  mode: QuotaMode;
  exhausted: boolean;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  monthlyInputTokenLimit: number;
  monthlyOutputTokenLimit: number;
  requestCount: number;
  renewsAt: number;
}

export type AuthorizeMeterOutcome =
  | {
      allowed: true;
      mode: QuotaMode;
      leaseId: string;
      state: LicenceStateRecord;
      usage: LicenceUsageSummary;
    }
  | {
      allowed: false;
      httpStatus: 403 | 429;
      reason: "revoked" | "expired" | "quota_exceeded" | "concurrency_limit" | "device_limit" | "rate_limited";
      message: string;
      state: LicenceStateRecord;
      usage: LicenceUsageSummary;
      retryAfterSeconds?: number;
    };

export interface UpsertDeviceInput {
  licenceId: string;
  deviceId: string;
  keyId: string;
  status: SubscriptionStatusId;
  plan: string;
  periodEnd: number;
  notAfter: number;
  monthlyCapMicroUsd: number;
  deviceLimit?: number;
  now?: number;
}

export type UpsertDeviceOutcome =
  | {
      ok: true;
      replacedKeyId: string | null;
      evictedKeyId: string | null;
      state: LicenceStateRecord;
    }
  | {
      ok: false;
      reason: "device_limit";
      limit: number;
    };

export interface SetLicenceStateInput {
  licenceId: string;
  status: SubscriptionStatusId;
  periodEnd: number;
  notAfter: number;
  plan?: string;
  monthlyCapMicroUsd?: number;
  deviceLimit?: number;
  now?: number;
}

/**
 * Simultaneous streams per device seat: Free 2, Pro 12 (a battery-life ceiling). A meter covers
 * `deviceLimit` seats (1 for a Free device, 2+ for a Pro licence), so its cap is per-seat x seats.
 * Over the cap a new stream is refused (429), never admitted by evicting a running one.
 */
export const FREE_STREAMS_PER_DEVICE = 2;
export const PRO_STREAMS_PER_DEVICE = 12;
/**
 * Crash-cleanup horizon for a lease. A finished stream releases its lease when its spend is
 * recorded; the TTL only matters if that never happens, and it must outlast a long reasoning
 * stream or the stream would stop counting toward the cap while still running.
 */
const LEASE_TTL_MS = 5 * 60_000;
const IDLE_DEVICE_EVICTION_MS = 14 * 86_400_000;
const DUPLICATE_PROMPT_WINDOW_MS = 5_000;
const DUPLICATE_PROMPT_MAX_STREAK = 30;
const DUPLICATE_PROMPT_COOLDOWN_MS = 15_000;

interface InternalUsageRow {
  usedMicroUsd: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  updatedAt: number;
}

export class LicenceMeter extends DurableObject<Env> {
  private sqlReady = false;
  private memState: LicenceStateRecord | null = null;
  private readonly memDevices = new Map<string, LicenceDeviceSeat>();
  private readonly memUsage = new Map<string, InternalUsageRow>();
  private readonly memLeases = new Map<string, number>();
  private lastPromptHash = "";
  private promptStreak = 0;
  private lastPromptAt = 0;
  private promptBlockedUntil = 0;
  private lastPrunedPeriod = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initSqlIfAvailable();
  }

  private hasSql(): boolean {
    const storage = this.ctx?.storage as unknown as { sql?: { exec?: unknown } } | undefined;
    return Boolean(storage && storage.sql && typeof storage.sql.exec === "function");
  }

  private sqlExec(query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> {
    const storage = this.ctx.storage as unknown as {
      sql: { exec: (q: string, ...b: unknown[]) => Iterable<Record<string, unknown>> };
    };
    return storage.sql.exec(query, ...bindings);
  }

  private initSqlIfAvailable(): void {
    if (this.sqlReady || !this.hasSql()) return;
    try {
      this.sqlExec(`
        CREATE TABLE IF NOT EXISTS licence_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          licence_id TEXT NOT NULL,
          status TEXT NOT NULL,
          plan TEXT NOT NULL,
          period_end INTEGER NOT NULL,
          not_after INTEGER NOT NULL,
          monthly_cap_micro_usd INTEGER NOT NULL,
          hard_cap_micro_usd INTEGER NOT NULL,
          device_limit INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          key_id TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS monthly_usage (
          period_id TEXT PRIMARY KEY,
          used_micro_usd INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          request_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS concurrency_leases (
          lease_id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
      `);
      try {
        this.sqlExec(`ALTER TABLE monthly_usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0`);
      } catch {
        // Column already exists.
      }
      try {
        this.sqlExec(`ALTER TABLE monthly_usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0`);
      } catch {
        // Column already exists.
      }
      this.sqlReady = true;
    } catch {
      // Fallback to in-memory maps when running in a test environment without SQLite storage.
      this.sqlReady = false;
    }
  }

  private defaultState(now: number): LicenceStateRecord {
    const monthlyCapMicroUsd = DEFAULT_SOFT_CAP_MICRO_USD;
    return {
      licenceId: "",
      status: STATUS.ACTIVE,
      plan: "pro_yearly",
      periodEnd: 0,
      notAfter: 0,
      monthlyCapMicroUsd,
      hardCapMicroUsd: Math.round(monthlyCapMicroUsd * DEFAULT_HARD_CAP_MULTIPLIER),
      deviceLimit: DEFAULT_DEVICE_LIMIT,
      updatedAt: now,
    };
  }

  private readState(now: number): LicenceStateRecord {
    this.initSqlIfAvailable();
    if (this.sqlReady) {
      const rows = [...this.sqlExec(`SELECT * FROM licence_state WHERE id = 1`)];
      const row = rows[0];
      if (row) {
        return {
          licenceId: String(row["licence_id"] ?? ""),
          status: (row["status"] as SubscriptionStatusId) ?? STATUS.ACTIVE,
          plan: String(row["plan"] ?? "pro_yearly"),
          periodEnd: Number(row["period_end"] ?? 0),
          notAfter: Number(row["not_after"] ?? 0),
          monthlyCapMicroUsd: Number(row["monthly_cap_micro_usd"] ?? DEFAULT_SOFT_CAP_MICRO_USD),
          hardCapMicroUsd: Number(
            row["hard_cap_micro_usd"] ?? Math.round(DEFAULT_SOFT_CAP_MICRO_USD * DEFAULT_HARD_CAP_MULTIPLIER),
          ),
          deviceLimit: Number(row["device_limit"] ?? DEFAULT_DEVICE_LIMIT),
          updatedAt: Number(row["updated_at"] ?? now),
        };
      }
    }
    return this.memState ? { ...this.memState } : this.defaultState(now);
  }

  private writeState(state: LicenceStateRecord): void {
    this.memState = { ...state };
    if (this.sqlReady) {
      this.sqlExec(
        `INSERT INTO licence_state (
          id, licence_id, status, plan, period_end, not_after,
          monthly_cap_micro_usd, hard_cap_micro_usd, device_limit, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          licence_id = excluded.licence_id,
          status = excluded.status,
          plan = excluded.plan,
          period_end = excluded.period_end,
          not_after = excluded.not_after,
          monthly_cap_micro_usd = excluded.monthly_cap_micro_usd,
          hard_cap_micro_usd = excluded.hard_cap_micro_usd,
          device_limit = excluded.device_limit,
          updated_at = excluded.updated_at`,
        state.licenceId,
        state.status,
        state.plan,
        state.periodEnd,
        state.notAfter,
        state.monthlyCapMicroUsd,
        state.hardCapMicroUsd,
        state.deviceLimit,
        state.updatedAt,
      );
    }
  }

  private readDevices(): LicenceDeviceSeat[] {
    if (this.sqlReady) {
      const rows = [...this.sqlExec(`SELECT device_id, key_id, first_seen_at, last_seen_at FROM devices`)];
      return rows.map((r) => ({
        deviceId: String(r["device_id"]),
        keyId: String(r["key_id"]),
        firstSeenAt: Number(r["first_seen_at"]),
        lastSeenAt: Number(r["last_seen_at"]),
      }));
    }
    return [...this.memDevices.values()];
  }

  private putDeviceSeat(seat: LicenceDeviceSeat): void {
    this.memDevices.set(seat.deviceId, { ...seat });
    if (this.sqlReady) {
      this.sqlExec(
        `INSERT INTO devices (device_id, key_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           key_id = excluded.key_id,
           last_seen_at = excluded.last_seen_at`,
        seat.deviceId,
        seat.keyId,
        seat.firstSeenAt,
        seat.lastSeenAt,
      );
    }
  }

  private deleteDeviceSeat(deviceId: string): void {
    this.memDevices.delete(deviceId);
    if (this.sqlReady) {
      this.sqlExec(`DELETE FROM devices WHERE device_id = ?`, deviceId);
    }
  }

  private readUsageRow(periodId: string, now: number): InternalUsageRow {
    if (this.sqlReady) {
      const rows = [
        ...this.sqlExec(
          `SELECT used_micro_usd, tokens, input_tokens, output_tokens, request_count, updated_at FROM monthly_usage WHERE period_id = ?`,
          periodId,
        ),
      ];
      const row = rows[0];
      if (row) {
        return {
          usedMicroUsd: Number(row["used_micro_usd"] ?? 0),
          tokens: Number(row["tokens"] ?? 0),
          inputTokens: Number(row["input_tokens"] ?? 0),
          outputTokens: Number(row["output_tokens"] ?? 0),
          requestCount: Number(row["request_count"] ?? 0),
          updatedAt: Number(row["updated_at"] ?? now),
        };
      }
    }
    const existing = this.memUsage.get(periodId);
    return existing
      ? { ...existing }
      : { usedMicroUsd: 0, tokens: 0, inputTokens: 0, outputTokens: 0, requestCount: 0, updatedAt: now };
  }

  private buildUsageSummary(state: LicenceStateRecord, periodId: string, now: number): LicenceUsageSummary {
    const row = this.readUsageRow(periodId, now);
    const tier = tierForProductId(state.plan);
    const monthlyInputTokenLimit = monthlyInputTokenLimitFor(state.plan);
    const monthlyOutputTokenLimit = monthlyOutputTokenLimitFor(state.plan);
    const capCheck = checkTierTokenCaps(
      { inputTokens: row.inputTokens, outputTokens: row.outputTokens },
      state.plan,
      periodId,
    );
    // Free always follows the current Free budget (DEFAULT_FREE_MONTHLY_CAP_MICRO_USD), whatever cap a
    // device was upserted with, so a budget change applies to every Free device at once. Free has no
    // reduced mode: its soft and hard cap are the same number.
    const softCap =
      tier === PLAN_FREE
        ? DEFAULT_FREE_MONTHLY_CAP_MICRO_USD
        : state.monthlyCapMicroUsd > 0
          ? state.monthlyCapMicroUsd
          : DEFAULT_SOFT_CAP_MICRO_USD;
    const hardCap =
      tier === PLAN_FREE
        ? softCap
        : state.hardCapMicroUsd > 0
          ? state.hardCapMicroUsd
          : Math.round(softCap * DEFAULT_HARD_CAP_MULTIPLIER);
    const usedPpm = microUsdToPpm(row.usedMicroUsd, softCap);
    const mode: QuotaMode = tier === PLAN_FREE ? "normal" : row.usedMicroUsd >= softCap ? "reduced" : "normal";
    const exhausted = row.usedMicroUsd >= hardCap || !capCheck.allowed;
    return {
      periodId,
      tier,
      usedMicroUsd: row.usedMicroUsd,
      monthlyCapMicroUsd: softCap,
      hardCapMicroUsd: hardCap,
      usedPpm,
      limitPpm: PPM_LIMIT,
      mode,
      exhausted,
      tokens: row.tokens,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      monthlyInputTokenLimit,
      monthlyOutputTokenLimit,
      requestCount: row.requestCount,
      renewsAt: periodRenewsAt(now),
    };
  }

  private pruneExpiredLeases(now: number): number {
    if (this.sqlReady) {
      this.sqlExec(`DELETE FROM concurrency_leases WHERE expires_at <= ?`, now);
      const rows = [...this.sqlExec(`SELECT COUNT(*) AS cnt FROM concurrency_leases`)];
      return Number(rows[0]?.["cnt"] ?? 0);
    }
    for (const [id, exp] of this.memLeases.entries()) {
      if (exp <= now) this.memLeases.delete(id);
    }
    return this.memLeases.size;
  }

  /** Automatically clears usage records older than 3 months (`QUOTA_RETENTION_MONTHS = 2` prior months + current). */
  private pruneStaleUsagePeriods(currentPeriodId: string): void {
    if (this.lastPrunedPeriod === currentPeriodId) return;
    this.lastPrunedPeriod = currentPeriodId;
    for (const period of [...this.memUsage.keys()]) {
      const age = monthsBetween(currentPeriodId, period);
      if (age !== null && age > QUOTA_RETENTION_MONTHS) {
        this.memUsage.delete(period);
      }
    }
    if (this.sqlReady) {
      const rows = [...this.sqlExec(`SELECT period_id FROM monthly_usage`)];
      for (const r of rows) {
        const period = String(r["period_id"] ?? "");
        const age = monthsBetween(currentPeriodId, period);
        if (age !== null && age > QUOTA_RETENTION_MONTHS) {
          this.sqlExec(`DELETE FROM monthly_usage WHERE period_id = ?`, period);
        }
      }
    }
  }

  private insertLease(leaseId: string, expiresAt: number): void {
    this.memLeases.set(leaseId, expiresAt);
    if (this.sqlReady) {
      this.sqlExec(
        `INSERT OR REPLACE INTO concurrency_leases (lease_id, expires_at) VALUES (?, ?)`,
        leaseId,
        expiresAt,
      );
    }
  }

  /**
   * Global Free spend for one UTC day (only the `global:free-spend` instance uses these). Stored in
   * Durable Object storage so every edge location reads the same number.
   */
  private readonly memGlobalSpend = new Map<string, number>();

  private kvStorage(): { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> } | null {
    const storage = this.ctx?.storage as unknown as { get?: unknown; put?: unknown } | undefined;
    return storage && typeof storage.get === "function" && typeof storage.put === "function"
      ? (storage as unknown as { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> })
      : null;
  }

  async getGlobalSpend(dayId: string): Promise<number> {
    const key = `global-spend:${dayId}`;
    const storage = this.kvStorage();
    const value = storage ? await storage.get<number>(key) : this.memGlobalSpend.get(key);
    return typeof value === "number" ? value : 0;
  }

  async addGlobalSpend(dayId: string, costMicroUsd: number): Promise<number> {
    const delta = Math.max(0, Math.round(costMicroUsd) || 0);
    const key = `global-spend:${dayId}`;
    const next = (await this.getGlobalSpend(dayId)) + delta;
    const storage = this.kvStorage();
    if (storage) await storage.put(key, next);
    else this.memGlobalSpend.set(key, next);
    return next;
  }

  async releaseLease(leaseId: string): Promise<void> {
    if (!leaseId) return;
    this.memLeases.delete(leaseId);
    if (this.sqlReady) {
      this.sqlExec(`DELETE FROM concurrency_leases WHERE lease_id = ?`, leaseId);
    }
  }

  async setLicenceState(input: SetLicenceStateInput): Promise<{ state: LicenceStateRecord; keyIds: string[] }> {
    const now = input.now ?? Date.now();
    const current = this.readState(now);
    const tier = tierForProductId(input.plan ?? current.plan);
    const defaultCap = tier === PLAN_FREE ? DEFAULT_FREE_MONTHLY_CAP_MICRO_USD : DEFAULT_SOFT_CAP_MICRO_USD;
    const monthlyCapMicroUsd =
      input.monthlyCapMicroUsd && input.monthlyCapMicroUsd > 0
        ? Math.round(input.monthlyCapMicroUsd)
        : current.licenceId !== "" && current.monthlyCapMicroUsd > 0
          ? current.monthlyCapMicroUsd
          : defaultCap;
    const hardCapMicroUsd =
      tier === PLAN_FREE ? monthlyCapMicroUsd : Math.round(monthlyCapMicroUsd * DEFAULT_HARD_CAP_MULTIPLIER);
    const next: LicenceStateRecord = {
      licenceId: input.licenceId || current.licenceId,
      status: input.status,
      plan: input.plan ?? current.plan,
      periodEnd: input.periodEnd,
      notAfter: input.notAfter,
      monthlyCapMicroUsd,
      hardCapMicroUsd,
      deviceLimit: input.deviceLimit ?? current.deviceLimit,
      updatedAt: now,
    };
    this.writeState(next);
    const keyIds = this.readDevices().map((d) => d.keyId);
    return { state: next, keyIds };
  }

  async upsertDevice(input: UpsertDeviceInput): Promise<UpsertDeviceOutcome> {
    const now = input.now ?? Date.now();
    const current = this.readState(now);
    const tier = tierForProductId(input.plan || current.plan);
    const defaultCap = tier === PLAN_FREE ? DEFAULT_FREE_MONTHLY_CAP_MICRO_USD : DEFAULT_SOFT_CAP_MICRO_USD;
    const monthlyCapMicroUsd =
      input.monthlyCapMicroUsd > 0
        ? Math.round(input.monthlyCapMicroUsd)
        : current.licenceId !== "" && current.monthlyCapMicroUsd > 0
          ? current.monthlyCapMicroUsd
          : defaultCap;
    const hardCapMicroUsd =
      tier === PLAN_FREE ? monthlyCapMicroUsd : Math.round(monthlyCapMicroUsd * DEFAULT_HARD_CAP_MULTIPLIER);
    const deviceLimit = input.deviceLimit !== undefined ? input.deviceLimit : current.deviceLimit;
    const nextState: LicenceStateRecord = {
      licenceId: input.licenceId || current.licenceId,
      status: input.status,
      plan: input.plan || current.plan,
      periodEnd: input.periodEnd,
      notAfter: input.notAfter,
      monthlyCapMicroUsd,
      hardCapMicroUsd,
      deviceLimit,
      updatedAt: now,
    };
    this.writeState(nextState);

    const devices = this.readDevices();
    const existing = devices.find((d) => d.deviceId === input.deviceId);
    if (existing) {
      const replacedKeyId = existing.keyId !== input.keyId ? existing.keyId : null;
      this.putDeviceSeat({
        deviceId: input.deviceId,
        keyId: input.keyId,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: now,
      });
      return { ok: true, replacedKeyId, evictedKeyId: null, state: nextState };
    }

    let evictedKeyId: string | null = null;
    if (deviceLimit > 0 && devices.length >= deviceLimit) {
      // Check if any bound device has been idle for >= 14 days
      const idleCandidates = devices
        .filter((d) => now - d.lastSeenAt >= IDLE_DEVICE_EVICTION_MS)
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      const victim = idleCandidates[0];
      if (!victim) {
        return { ok: false, reason: "device_limit", limit: deviceLimit };
      }
      evictedKeyId = victim.keyId;
      this.deleteDeviceSeat(victim.deviceId);
    }

    this.putDeviceSeat({
      deviceId: input.deviceId,
      keyId: input.keyId,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return { ok: true, replacedKeyId: null, evictedKeyId, state: nextState };
  }

  async releaseDevice(input: {
    licenceId: string;
    deviceId: string;
    now?: number;
  }): Promise<{ releasedKeyId: string | null }> {
    const devices = this.readDevices();
    const existing = devices.find((d) => d.deviceId === input.deviceId);
    if (!existing) {
      return { releasedKeyId: null };
    }
    this.deleteDeviceSeat(input.deviceId);
    return { releasedKeyId: existing.keyId };
  }

  async getUsage(periodId?: string, now = Date.now()): Promise<LicenceUsageSummary> {
    const state = this.readState(now);
    const targetPeriod = periodId && periodId.trim() !== "" ? periodId.trim() : periodIdFor(now);
    return this.buildUsageSummary(state, targetPeriod, now);
  }

  async authorizeRequest(input: {
    keyId: string;
    deviceId?: string;
    now?: number;
    acquireLease?: boolean;
    promptHash?: string;
  }): Promise<AuthorizeMeterOutcome> {
    const now = input.now ?? Date.now();
    const state = this.readState(now);
    const periodId = periodIdFor(now);
    this.pruneStaleUsagePeriods(periodId);
    const usage = this.buildUsageSummary(state, periodId, now);

    if (this.promptBlockedUntil > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.promptBlockedUntil - now) / 1000));
      return {
        allowed: false,
        httpStatus: 429,
        reason: "rate_limited",
        message: `Repeated identical prompts sent too quickly. Please wait ${retryAfterSeconds}s before sending again.`,
        state,
        usage,
        retryAfterSeconds,
      };
    }

    if (input.promptHash && input.promptHash.trim() !== "") {
      if (input.promptHash === this.lastPromptHash && now - this.lastPromptAt <= DUPLICATE_PROMPT_WINDOW_MS) {
        this.promptStreak += 1;
        this.lastPromptAt = now;
        if (this.promptStreak >= DUPLICATE_PROMPT_MAX_STREAK) {
          this.promptBlockedUntil = now + DUPLICATE_PROMPT_COOLDOWN_MS;
          this.promptStreak = 0;
          return {
            allowed: false,
            httpStatus: 429,
            reason: "rate_limited",
            message: "Repeated identical prompts sent too quickly. Please wait 15s before sending again.",
            state,
            usage,
            retryAfterSeconds: Math.ceil(DUPLICATE_PROMPT_COOLDOWN_MS / 1000),
          };
        }
      } else {
        this.lastPromptHash = input.promptHash;
        this.promptStreak = 1;
        this.lastPromptAt = now;
      }
    }

    if (state.status === STATUS.REVOKED) {
      return {
        allowed: false,
        httpStatus: 403,
        reason: "revoked",
        message: "This Gestu Pro licence has been revoked.",
        state,
        usage,
      };
    }

    const effectiveExpiry = Math.max(state.periodEnd, state.notAfter);
    if (!isGrantActive(state.status, effectiveExpiry, now)) {
      const message =
        usage.tier === PLAN_FREE
          ? "Your 7-day Gestu Free trial has ended. Upgrade to Gestu Pro, use an on-device model, or add your own API key in Settings."
          : `This Gestu Pro licence is ${state.status}. Renew your plan or add your own API key in Settings.`;
      return {
        allowed: false,
        httpStatus: 403,
        reason: "expired",
        message,
        state,
        usage,
      };
    }

    const devices = this.readDevices();
    if (devices.length > 0) {
      const matched = devices.find((d) => d.keyId === input.keyId || (input.deviceId && d.deviceId === input.deviceId));
      if (matched) {
        this.putDeviceSeat({ ...matched, lastSeenAt: now });
      }
    }

    if (usage.exhausted) {
      const capCheck = checkTierTokenCaps(
        { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        state.plan,
        usage.periodId,
      );
      const planLabel = usage.tier === PLAN_FREE ? "Gestu Free" : "Gestu Pro";
      const percentUsed = Math.min(100, Math.round((usage.usedPpm / Math.max(1, usage.limitPpm)) * 100));
      const message = !capCheck.allowed
        ? capCheck.message
        : `${planLabel} monthly usage allowance for ${usage.periodId} is reached ` +
          `(${percentUsed}% used). The allowance resets on the 1st.`;
      return {
        allowed: false,
        httpStatus: 429,
        reason: "quota_exceeded",
        message,
        state,
        usage,
      };
    }

    let leaseId = "";
    if (input.acquireLease !== false) {
      const activeLeases = this.pruneExpiredLeases(now);
      const perSeat = usage.tier === PLAN_FREE ? FREE_STREAMS_PER_DEVICE : PRO_STREAMS_PER_DEVICE;
      // A Free meter is one device by construction, whatever device limit it was upserted with.
      const seats = usage.tier === PLAN_FREE ? 1 : Math.max(1, Math.trunc(state.deviceLimit || 1));
      const maxLeases = perSeat * seats;
      if (activeLeases >= maxLeases) {
        return {
          allowed: false,
          httpStatus: 429,
          reason: "rate_limited",
          message: `Too many responses running at once (limit ${maxLeases}). Wait for one to finish and try again.`,
          state,
          usage,
          retryAfterSeconds: 5,
        };
      }
      leaseId = `${now}_${Math.random().toString(36).slice(2, 10)}`;
      this.insertLease(leaseId, now + LEASE_TTL_MS);
    }

    return {
      allowed: true,
      mode: usage.mode,
      leaseId,
      state,
      usage,
    };
  }

  async recordSpend(input: {
    periodId?: string;
    costMicroUsd: number;
    tokens: number;
    inputTokens?: number;
    outputTokens?: number;
    leaseId?: string;
    now?: number;
  }): Promise<LicenceUsageSummary> {
    const now = input.now ?? Date.now();
    if (input.leaseId) {
      await this.releaseLease(input.leaseId);
    }
    const state = this.readState(now);
    const periodId = input.periodId && input.periodId.trim() !== "" ? input.periodId.trim() : periodIdFor(now);
    const costDelta = Math.max(0, Math.round(input.costMicroUsd) || 0);
    const inputDelta = Math.max(0, Math.trunc(input.inputTokens ?? 0) || 0);
    const outputDelta = Math.max(0, Math.trunc(input.outputTokens ?? 0) || 0);
    const tokenDelta = Math.max(0, Math.trunc(input.tokens) || inputDelta + outputDelta);

    const current = this.readUsageRow(periodId, now);
    const next: InternalUsageRow = {
      usedMicroUsd: current.usedMicroUsd + costDelta,
      tokens: current.tokens + tokenDelta,
      inputTokens: current.inputTokens + inputDelta,
      outputTokens: current.outputTokens + outputDelta,
      requestCount: current.requestCount + 1,
      updatedAt: now,
    };
    this.memUsage.set(periodId, next);
    if (this.sqlReady) {
      this.sqlExec(
        `INSERT INTO monthly_usage (period_id, used_micro_usd, tokens, input_tokens, output_tokens, request_count, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(period_id) DO UPDATE SET
           used_micro_usd = monthly_usage.used_micro_usd + excluded.used_micro_usd,
           tokens = monthly_usage.tokens + excluded.tokens,
           input_tokens = monthly_usage.input_tokens + excluded.input_tokens,
           output_tokens = monthly_usage.output_tokens + excluded.output_tokens,
           request_count = monthly_usage.request_count + 1,
           updated_at = excluded.updated_at`,
        periodId,
        costDelta,
        tokenDelta,
        inputDelta,
        outputDelta,
        now,
      );
    }
    return this.buildUsageSummary(state, periodId, now);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method.toUpperCase() !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405 });
    }
    const body = (await request.json()) as { action: string; payload?: unknown };
    switch (body.action) {
      case "setLicenceState":
        return Response.json(await this.setLicenceState(body.payload as SetLicenceStateInput));
      case "upsertDevice":
        return Response.json(await this.upsertDevice(body.payload as UpsertDeviceInput));
      case "releaseDevice":
        return Response.json(
          await this.releaseDevice(body.payload as { licenceId: string; deviceId: string; now?: number }),
        );
      case "getUsage": {
        const p = (body.payload ?? {}) as { periodId?: string; now?: number };
        return Response.json(await this.getUsage(p.periodId, p.now));
      }
      case "authorizeRequest":
        return Response.json(
          await this.authorizeRequest(
            body.payload as { keyId: string; deviceId?: string; now?: number; acquireLease?: boolean },
          ),
        );
      case "recordSpend":
        return Response.json(
          await this.recordSpend(
            body.payload as {
              periodId?: string;
              costMicroUsd: number;
              tokens: number;
              inputTokens?: number;
              outputTokens?: number;
              leaseId?: string;
              now?: number;
            },
          ),
        );
      case "releaseLease": {
        const p = (body.payload ?? {}) as { leaseId: string };
        await this.releaseLease(p.leaseId);
        return Response.json({ ok: true });
      }
      case "getGlobalSpend": {
        const p = (body.payload ?? {}) as { dayId: string };
        return Response.json(await this.getGlobalSpend(p.dayId));
      }
      case "addGlobalSpend": {
        const p = (body.payload ?? {}) as { dayId: string; costMicroUsd: number };
        return Response.json(await this.addGlobalSpend(p.dayId, p.costMicroUsd));
      }
      default:
        return new Response(JSON.stringify({ ok: false, error: `unknown_action:${body.action}` }), { status: 400 });
    }
  }
}

export function hasLiveLicenceMeter(
  env: Env,
): env is Env & { LICENCE_METER: DurableObjectNamespace } {
  return Boolean(
    env.LICENCE_METER &&
      typeof (env.LICENCE_METER as { idFromName?: unknown }).idFromName === "function" &&
      typeof (env.LICENCE_METER as { get?: unknown }).get === "function",
  );
}

/**
 * Helper to invoke a `LicenceMeter` DurableObjectStub whether the runtime exposes direct RPC
 * methods on the stub or requires `stub.fetch("https://do/rpc", ...)`.
 */
export async function callLicenceMeter<T>(
  ns: DurableObjectNamespace,
  licenceId: string,
  action:
    | "setLicenceState"
    | "upsertDevice"
    | "releaseDevice"
    | "getUsage"
    | "authorizeRequest"
    | "recordSpend"
    | "releaseLease"
    | "getGlobalSpend"
    | "addGlobalSpend",
  payload: unknown,
): Promise<T> {
  const id = ns.idFromName(licenceId);
  const stub = ns.get(id) as unknown as LicenceMeter & Record<string, unknown> & { fetch: typeof fetch };
  if (typeof stub[action] === "function") {
    // Invoke directly on the stub without `.call(...)`: Cloudflare Workers RpcStub proxies treat
    // `.call` as a remote RPC method lookup (`The RPC receiver does not implement the method "call"`).
    switch (action) {
      case "setLicenceState":
        return (await stub.setLicenceState(payload as SetLicenceStateInput)) as unknown as T;
      case "upsertDevice":
        return (await stub.upsertDevice(payload as UpsertDeviceInput)) as unknown as T;
      case "releaseDevice":
        return (await stub.releaseDevice(
          payload as { licenceId: string; deviceId: string; now?: number },
        )) as unknown as T;
      case "getUsage": {
        const p = (payload ?? {}) as { periodId?: string; now?: number };
        return (await stub.getUsage(p.periodId, p.now)) as unknown as T;
      }
      case "authorizeRequest":
        return (await stub.authorizeRequest(
          payload as { keyId: string; deviceId?: string; now?: number; acquireLease?: boolean },
        )) as unknown as T;
      case "recordSpend":
        return (await stub.recordSpend(
          payload as {
            periodId?: string;
            costMicroUsd: number;
            tokens: number;
            inputTokens?: number;
            outputTokens?: number;
            leaseId?: string;
            now?: number;
          },
        )) as unknown as T;
      case "releaseLease": {
        const p = (payload ?? {}) as { leaseId: string };
        return (await stub.releaseLease(p.leaseId)) as unknown as T;
      }
      case "getGlobalSpend": {
        const p = (payload ?? {}) as { dayId: string };
        return (await stub.getGlobalSpend(p.dayId)) as unknown as T;
      }
      case "addGlobalSpend": {
        const p = (payload ?? {}) as { dayId: string; costMicroUsd: number };
        return (await stub.addGlobalSpend(p.dayId, p.costMicroUsd)) as unknown as T;
      }
    }
  }
  const response = await stub.fetch("https://licence-meter.internal/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  if (!response.ok) {
    throw new Error(`LicenceMeter RPC ${action} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
