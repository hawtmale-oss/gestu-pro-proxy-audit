/**
 * `InternalApi` — private Cloudflare Service Binding RPC entrypoint (`WorkerEntrypoint<Env>`).
 *
 * Called exclusively by `gestu-entitlement-service` over the `PROXY` service binding.
 * Never exposed on the public HTTP router.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./config";
import { readConfig, readUpstreamApiKey } from "./config";
import type { SubscriptionStatusId } from "./constants";
import { DEFAULT_DEVICE_LIMIT, PLAN_FREE, PRO_MONTHLY_INPUT_TOKENS, PRO_MONTHLY_OUTPUT_TOKENS, QUOTA_UNIT_PPM, STATUS, tierForProductId } from "./constants";
import { DEFAULT_FREE_MONTHLY_CAP_MICRO_USD, DEFAULT_SOFT_CAP_MICRO_USD, PPM_LIMIT } from "./cost";
import { retireFreeDeviceOnProUpgrade } from "./free";
import { recordFunnelEventOnce } from "./funnel";
import { licenceIndexKey } from "./licence";
import type { LicenceUsageSummary, UpsertDeviceOutcome } from "./licence-meter";
import { callLicenceMeter } from "./licence-meter";
import { periodIdFor, periodRenewsAt } from "./quota";
import {
  getKeyRecord,
  newKeyRecord,
  putKeyRecord,
  rememberActiveKey,
  revokeKey,
  updateKeyStatus,
} from "./store";

export interface InternalUpsertDeviceInput {
  licenceId: string;
  deviceId: string;
  keyId: string;
  status: string;
  plan: string;
  periodEnd: number;
  notAfter: number;
  monthlyCapMicroUsd: number;
  deviceLimit?: number;
  packageName?: string;
  now?: number;
}

export type InternalUpsertDeviceResult =
  | {
      ok: true;
      replacedKeyId: string | null;
      evictedKeyId: string | null;
    }
  | {
      ok: false;
      reason: "device_limit";
      limit: number;
    };

export interface InternalSetLicenceStateInput {
  licenceId: string;
  status: string;
  periodEnd: number;
  notAfter: number;
  plan?: string;
  monthlyCapMicroUsd?: number;
  now?: number;
}

export interface InternalReleaseDeviceInput {
  licenceId: string;
  deviceId: string;
  now?: number;
}

export interface InternalGetUsageInput {
  licenceId: string;
  periodId?: string;
  now?: number;
}

export interface InternalUsageResult {
  periodId: string;
  usedMicroUsd: number;
  monthlyCapMicroUsd: number;
  usedPpm: number;
  limitPpm: number;
  mode: "normal" | "reduced";
  tokens: number;
  requestCount: number;
  renewsAt: number;
  // Split token counters and tier ceilings: `entitlement-service` builds the client's
  // `ProProvisionResponse.quota*` fields from these, and the app meters output tokens, so the
  // output pair in particular must not be omitted.
  tier: string;
  inputTokens: number;
  outputTokens: number;
  monthlyInputTokenLimit: number;
  monthlyOutputTokenLimit: number;
}

export interface UpstreamBalanceResult {
  available: boolean;
  totalBalanceUsd: number | null;
  grantedBalanceUsd: number | null;
  toppedUpBalanceUsd: number | null;
  currency: string;
}

/**
 * Maps an `entitlement-service` status string to `pro-proxy`'s `SubscriptionStatusId`.
 *
 * A `canceled` subscription whose paid period has not yet ended (`effectiveExpiry > now`) or a
 * `past_due` subscription inside its 7-day grace window maps to `grace` so `isGrantActive`
 * continues to permit traffic until `effectiveExpiry`.
 */
export function mapEntitlementStatusToProxyStatus(
  rawStatus: string,
  effectiveExpiry: number,
  now: number,
): SubscriptionStatusId {
  switch (rawStatus) {
    case "active":
      return STATUS.ACTIVE;
    case "past_due":
    case "grace":
      return STATUS.GRACE;
    case "canceled":
      return effectiveExpiry > now ? STATUS.GRACE : STATUS.CANCELED;
    case "on_hold":
      return STATUS.ON_HOLD;
    case "expired":
      return STATUS.EXPIRED;
    case "revoked":
    case "suspended":
    case "refunded":
    case "chargeback":
      return STATUS.REVOKED;
    default:
      return STATUS.NONE;
  }
}

function licenceKeyListKey(licenceId: string): string {
  return `licence-keys:${licenceId}`;
}

async function readLicenceKeyIds(kv: KVNamespace, licenceId: string): Promise<string[]> {
  const raw = await kv.get(licenceKeyListKey(licenceId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writeLicenceKeyIds(kv: KVNamespace, licenceId: string, keyIds: string[]): Promise<void> {
  const unique = [...new Set(keyIds.filter((k) => k !== ""))];
  await kv.put(licenceKeyListKey(licenceId), JSON.stringify(unique));
}

export class InternalApi extends WorkerEntrypoint<Env> {
  async upsertDevice(input: InternalUpsertDeviceInput): Promise<InternalUpsertDeviceResult> {
    if (input.plan.trim().toLowerCase() === "gestu_pro_lifetime") {
      // Lifetime unlocks on-device Pro features only; never mint a managed Pro inference key.
      return { ok: false, reason: "device_limit", limit: 0 };
    }
    const now = input.now ?? Date.now();
    const effectiveExpiry = Math.max(input.periodEnd || 0, input.notAfter || 0);
    const proxyStatus = mapEntitlementStatusToProxyStatus(input.status, effectiveExpiry, now);
    const deviceLimit = input.deviceLimit ?? DEFAULT_DEVICE_LIMIT;
    const tier = tierForProductId(input.plan);
    const defaultCap =
      tier === PLAN_FREE ? DEFAULT_FREE_MONTHLY_CAP_MICRO_USD : DEFAULT_SOFT_CAP_MICRO_USD;
    const monthlyCapMicroUsd =
      input.monthlyCapMicroUsd > 0 ? Math.round(input.monthlyCapMicroUsd) : defaultCap;

    let replacedKeyId: string | null = null;
    let evictedKeyId: string | null = null;

    if (this.env.LICENCE_METER) {
      const outcome = await callLicenceMeter<UpsertDeviceOutcome>(
        this.env.LICENCE_METER,
        input.licenceId,
        "upsertDevice",
        {
          licenceId: input.licenceId,
          deviceId: input.deviceId,
          keyId: input.keyId,
          status: proxyStatus,
          plan: input.plan,
          periodEnd: input.periodEnd,
          notAfter: input.notAfter,
          monthlyCapMicroUsd,
          deviceLimit,
          now,
        },
      );
      if (!outcome.ok) {
        return { ok: false, reason: "device_limit", limit: outcome.limit };
      }
      replacedKeyId = outcome.replacedKeyId;
      evictedKeyId = outcome.evictedKeyId;
    } else {
      const existingKeyId = await this.env.PRO_KV.get(licenceIndexKey(input.licenceId, input.deviceId));
      if (existingKeyId && existingKeyId !== input.keyId) {
        replacedKeyId = existingKeyId;
      }
    }

    if (replacedKeyId) {
      await revokeKey(this.env.PRO_KV, replacedKeyId, STATUS.REVOKED, now);
    }
    if (evictedKeyId) {
      await revokeKey(this.env.PRO_KV, evictedKeyId, STATUS.REVOKED, now);
    }

    const freeUpgrade =
      tier !== PLAN_FREE ? await retireFreeDeviceOnProUpgrade(this.env, input.deviceId, now) : { retiredFreeKeyId: null, freeMeterId: null };

    const record = {
      ...newKeyRecord({
        keyId: input.keyId,
        packageName: input.packageName || "ca.gestu.app",
        productId: input.plan || "gestu_pro_yearly",
        obfuscatedAccountId: input.licenceId,
        expiresAt: effectiveExpiry,
        status: proxyStatus,
        playState: "",
        latestOrderId: "",
        deviceId: input.deviceId,
        deviceLimit,
        now,
      }),
      licenceId: input.licenceId,
      deviceId: input.deviceId,
      ...(freeUpgrade.freeMeterId ? { upgradedFromFreeMeterId: freeUpgrade.freeMeterId } : {}),
      quotaUnit: QUOTA_UNIT_PPM as "ppm",
      monthlyCapMicroUsd,
    };

    await putKeyRecord(this.env.PRO_KV, record);
    await rememberActiveKey(this.env.PRO_KV, input.keyId);
    await this.env.PRO_KV.put(licenceIndexKey(input.licenceId, input.deviceId), input.keyId);

    const tracked = await readLicenceKeyIds(this.env.PRO_KV, input.licenceId);
    const filtered = tracked.filter((id) => id !== replacedKeyId && id !== evictedKeyId);
    await writeLicenceKeyIds(this.env.PRO_KV, input.licenceId, [...filtered, input.keyId]);

    if (tier !== PLAN_FREE && proxyStatus === STATUS.ACTIVE && replacedKeyId === null) {
      await recordFunnelEventOnce(this.env, "pro_activated", input.licenceId, now);
    }

    return { ok: true, replacedKeyId, evictedKeyId };
  }

  async setLicenceState(
    input: InternalSetLicenceStateInput,
  ): Promise<{ ok: true; updatedKeyIds: string[] }> {
    const now = input.now ?? Date.now();
    const effectiveExpiry = Math.max(input.periodEnd || 0, input.notAfter || 0);
    const proxyStatus = mapEntitlementStatusToProxyStatus(input.status, effectiveExpiry, now);

    let doKeyIds: string[] = [];
    if (this.env.LICENCE_METER) {
      const res = await callLicenceMeter<{ keyIds: string[] }>(
        this.env.LICENCE_METER,
        input.licenceId,
        "setLicenceState",
        {
          licenceId: input.licenceId,
          status: proxyStatus,
          periodEnd: input.periodEnd,
          notAfter: input.notAfter,
          plan: input.plan,
          monthlyCapMicroUsd: input.monthlyCapMicroUsd,
          now,
        },
      );
      doKeyIds = res.keyIds ?? [];
    }

    const kvKeyIds = await readLicenceKeyIds(this.env.PRO_KV, input.licenceId);
    const allKeyIds = [...new Set([...doKeyIds, ...kvKeyIds])];

    for (const keyId of allKeyIds) {
      if (proxyStatus === STATUS.REVOKED) {
        await revokeKey(this.env.PRO_KV, keyId, STATUS.REVOKED, now);
      } else {
        await updateKeyStatus(
          this.env.PRO_KV,
          keyId,
          { status: proxyStatus, expiresAt: effectiveExpiry },
          now,
        );
      }
    }

    return { ok: true, updatedKeyIds: allKeyIds };
  }

  async releaseDevice(
    input: InternalReleaseDeviceInput,
  ): Promise<{ ok: true; releasedKeyId: string | null }> {
    const now = input.now ?? Date.now();
    let releasedKeyId: string | null = null;

    if (this.env.LICENCE_METER) {
      const res = await callLicenceMeter<{ releasedKeyId: string | null }>(
        this.env.LICENCE_METER,
        input.licenceId,
        "releaseDevice",
        {
          licenceId: input.licenceId,
          deviceId: input.deviceId,
          now,
        },
      );
      releasedKeyId = res.releasedKeyId;
    }

    const indexKey = licenceIndexKey(input.licenceId, input.deviceId);
    const indexedKeyId = await this.env.PRO_KV.get(indexKey);
    await this.env.PRO_KV.delete(indexKey);

    const targetKeyId = releasedKeyId ?? indexedKeyId;
    if (targetKeyId) {
      const existing = await getKeyRecord(this.env.PRO_KV, targetKeyId);
      if (existing) {
        await revokeKey(this.env.PRO_KV, targetKeyId, STATUS.REVOKED, now);
      }
      const tracked = await readLicenceKeyIds(this.env.PRO_KV, input.licenceId);
      await writeLicenceKeyIds(
        this.env.PRO_KV,
        input.licenceId,
        tracked.filter((id) => id !== targetKeyId),
      );
    }

    return { ok: true, releasedKeyId: targetKeyId ?? null };
  }

  async getUsage(input: InternalGetUsageInput): Promise<InternalUsageResult> {
    const now = input.now ?? Date.now();
    const periodId = input.periodId && input.periodId.trim() !== "" ? input.periodId.trim() : periodIdFor(now);

    if (this.env.LICENCE_METER) {
      const summary = await callLicenceMeter<LicenceUsageSummary>(
        this.env.LICENCE_METER,
        input.licenceId,
        "getUsage",
        { periodId, now },
      );
      return {
        periodId: summary.periodId,
        usedMicroUsd: summary.usedMicroUsd,
        monthlyCapMicroUsd: summary.monthlyCapMicroUsd,
        usedPpm: summary.usedPpm,
        limitPpm: summary.limitPpm,
        mode: summary.mode,
        tokens: summary.tokens,
        requestCount: summary.requestCount,
        renewsAt: summary.renewsAt,
        tier: summary.tier,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        monthlyInputTokenLimit: summary.monthlyInputTokenLimit,
        monthlyOutputTokenLimit: summary.monthlyOutputTokenLimit,
      };
    }

    return {
      periodId,
      usedMicroUsd: 0,
      monthlyCapMicroUsd: DEFAULT_SOFT_CAP_MICRO_USD,
      usedPpm: 0,
      limitPpm: PPM_LIMIT,
      mode: "normal",
      tokens: 0,
      requestCount: 0,
      renewsAt: periodRenewsAt(now),
      tier: "pro",
      inputTokens: 0,
      outputTokens: 0,
      monthlyInputTokenLimit: PRO_MONTHLY_INPUT_TOKENS,
      monthlyOutputTokenLimit: PRO_MONTHLY_OUTPUT_TOKENS,
    };
  }

  async getUpstreamBalance(): Promise<UpstreamBalanceResult> {
    const config = readConfig(this.env);
    const apiKey = readUpstreamApiKey(this.env);
    if (!apiKey) {
      return {
        available: false,
        totalBalanceUsd: null,
        grantedBalanceUsd: null,
        toppedUpBalanceUsd: null,
        currency: "USD",
      };
    }

    try {
      const response = await fetch(`${config.proUpstreamBaseUrl}/user/balance`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
        },
      });
      if (!response.ok) {
        // The Pro upstream is a prepaid direct provider API today (DeepSeek exposes /user/balance),
        // but an operator can point UPSTREAM_BASE_URL at a host that does not implement the balance
        // route. Treat "no balance endpoint" as unknown-but-available so the daily health monitor
        // only alerts on a genuinely empty prepaid balance, not on a missing optional route.
        return {
          available: response.status !== 401 && response.status !== 402,
          totalBalanceUsd: null,
          grantedBalanceUsd: null,
          toppedUpBalanceUsd: null,
          currency: "USD",
        };
      }
      const data = (await response.json()) as {
        is_available?: boolean;
        balance_infos?: Array<{
          currency?: string;
          total_balance?: string | number;
          granted_balance?: string | number;
          topped_up_balance?: string | number;
        }>;
      };
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
      const usdInfo = infos.find((entry) => entry.currency === "USD") ?? infos[0];
      const parseNum = (val: unknown): number | null => {
        if (typeof val === "number" && Number.isFinite(val)) return val;
        if (typeof val === "string" && val.trim() !== "") {
          const n = Number(val);
          return Number.isFinite(n) ? n : null;
        }
        return null;
      };
      return {
        available: data.is_available !== false,
        totalBalanceUsd: usdInfo ? parseNum(usdInfo.total_balance) : null,
        grantedBalanceUsd: usdInfo ? parseNum(usdInfo.granted_balance) : null,
        toppedUpBalanceUsd: usdInfo ? parseNum(usdInfo.topped_up_balance) : null,
        currency: usdInfo?.currency ?? "USD",
      };
    } catch {
      return {
        available: false,
        totalBalanceUsd: null,
        grantedBalanceUsd: null,
        toppedUpBalanceUsd: null,
        currency: "USD",
      };
    }
  }
}
