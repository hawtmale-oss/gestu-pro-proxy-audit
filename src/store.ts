/**
 * The KV data model.
 *
 * Layout (every key is prefixed so `kv:key list` is readable and so a prune can be scoped):
 *
 * ```
 * key:<sha256(virtualKey)>          → KeyRecord        (never the key itself)
 * purchase:<sha256(purchaseToken)>  → PurchaseRecord   (purchase token → key, one per token)
 * quota:<keyId>:<yyyy-MM>           → QuotaRecord      (rolled-up counter per key per month)
 * quota:usage:<keyId>:<yyyy-MM>:*   → per-request usage delta token count
 * index:active-keys                 → string[]         (hashes, for maintenance only)
 * google:access-token               → cached OAuth2 access token (see google.ts)
 * ```
 *
 * Why hashes at rest: a KV dump, a dashboard view or a log line must not hand over a working
 * credential. `sha256` of the key is enough to look it up and useless to present as a bearer
 * token; the same goes for purchase tokens, which are equally replayable.
 *
 * Concurrency & Quota Accounting: Workers KV has no atomic increment or compare-and-swap.
 * To eliminate parallel request race conditions where concurrent read-modify-writes overwrite each other
 * and overrun the monthly quota cap, each request writes an independent immutable usage delta record at
 * `quota:usage:<keyId>:<periodId>:<timestamp>_<random>`. On read, all deltas are summed (with fallback
 * to any legacy base QuotaRecord), and the cumulative counter is opportunistically rolled up into `quota:<keyId>:<periodId>`.
 * Old usage delta keys are pruned during scheduled maintenance alongside stale quota records.
 */

import { sha256Hex } from "./base64";
import type { SubscriptionStatusId } from "./constants";
import { STATUS } from "./constants";
import type { QuotaSnapshot } from "./quota";
import { periodIdFor, periodRenewsAt, quotaSnapshot } from "./quota";

/** Everything the Worker knows about one minted virtual key. */
export interface KeyRecord {
  /** Internal id, equal to the key's hash. Carried explicitly for quota keys. */
  keyId: string;
  /** Purchase token hashes currently linked to this key (upgrades add, they do not replace). */
  purchaseTokenHashes: string[];
  /** Devices that provisioned this key. Capped by [deviceLimit]. */
  devices: DeviceBinding[];
  /**
   * How many devices this key may serve; `0` means no cap.
   *
   * Stored on the record rather than read from configuration at each use, because the answer
   * differs per key: a Play subscription takes the deployment's `GESTU_DEVICE_LIMIT`, while a
   * business licence takes the count its own signed token declares — which may be "unlimited".
   * Reading it back from the record is what lets `/api/subscription-status` enforce the same cap
   * the provisioning call applied. Without it the two paths would disagree, and a licence issued
   * for five seats could be widened to any number simply by asking the other endpoint.
   *
   * Absent on records written before the field existed, which is why [deviceLimitFor] falls back to
   * the configured limit rather than to zero.
   */
  deviceLimit?: number;
  /** `obfuscatedExternalAccountId` from Play, when the purchase carried one. */
  obfuscatedAccountId: string;
  packageName: string;
  productId: string;
  /** Epoch millis at which the subscription's paid period ends. 0 = unknown. */
  expiresAt: number;
  status: SubscriptionStatusId;
  /** Last Play `subscriptionState` seen, verbatim, for the audit trail. */
  playState: string;
  /** Latest Google order id, for support ("which purchase is this?"). Not a credential. */
  latestOrderId: string;
  /** Epoch millis of the last status change. */
  updatedAt: number;
  revokedAt: number;
  /** Licence ID when this virtual key is backed by a consumer or business licence (`LicenceMeter`). */
  licenceId?: string;
  /** Bound device ID for per-device licence keys and for Free managed keys. */
  deviceId?: string;
  /**
   * Stable id under which this key's monthly token counters are stored. Defaults to [keyId].
   *
   * Free managed keys set it to a hash of the device id: the Free allowance is **per device**, and
   * a reinstall rotates the key secret (only its hash can be stored) but must not reset the month.
   */
  meterId?: string;
  /**
   * Set when a Pro licence or subscription record upgraded a device that previously held a Free
   * credential under the same `deviceId`, linking the two records to one install identity.
   */
  upgradedFromFreeMeterId?: string;
  /** Quota unit reported in `X-Gestu-Quota-Unit` ("ppm" for licence keys, "tokens" for Play/Free keys). */
  quotaUnit?: "ppm" | "tokens";
  /** Monthly soft cap in micro-USD for licence-backed keys. */
  monthlyCapMicroUsd?: number;
  /** Epoch millis when this device's Free trial first started (stable across reinstalls). */
  trialStartedAt?: number;
}

export interface DeviceBinding {
  deviceId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** One purchase token's pointer at a key. */
export interface PurchaseRecord {
  tokenHash: string;
  keyId: string;
  packageName: string;
  productId: string;
  obfuscatedAccountId: string;
  status: SubscriptionStatusId;
  expiresAt: number;
  updatedAt: number;
  /** Old purchase token hash this purchase replaced, when Play reported `linkedPurchaseToken`. */
  linkedTokenHash: string;
}

/** One key's counter for one billing period. */
export interface QuotaRecord {
  keyId: string;
  periodId: string;
  usedTokens: number;
  limitTokens: number;
  renewsAt: number;
  updatedAt: number;
}

const KEY_PREFIX = "key:";
const PURCHASE_PREFIX = "purchase:";
const QUOTA_PREFIX = "quota:";
const ACTIVE_KEYS_KEY = "index:active-keys";

/** Months of quota history kept by the scheduled prune. Two is enough for a support question. */
export const QUOTA_RETENTION_MONTHS = 2;

/**
 * The maintenance index.
 *
 * Workers KV `list` filters by key *prefix* only, so a key id cannot be searched for by suffix —
 * `quota:<id>:<period>` cannot be enumerated per key. This index is how the scheduled handler knows
 * which keys and which periods have ever existed, without listing the whole namespace. It is
 * best-effort by design: if it is missing or stale the only consequence is that a quota record is
 * not pruned, never that access breaks.
 */
export interface MaintenanceIndex {
  keyIds: string[];
  /** Every period a quota counter has been written for, so the prune never guesses. */
  periods: string[];
}

const EMPTY_INDEX: MaintenanceIndex = { keyIds: [], periods: [] };

/** Cap on tracked keys; beyond this the prune simply does less, and says so. */
const MAX_INDEXED_KEYS = 5000;
/** Cap on tracked periods (two years of months is far more than the retention window needs). */
const MAX_INDEXED_PERIODS = 24;

export function keyRecordKey(keyId: string): string {
  return `${KEY_PREFIX}${keyId}`;
}

export function purchaseRecordKey(tokenHash: string): string {
  return `${PURCHASE_PREFIX}${tokenHash}`;
}

export function quotaRecordKey(keyId: string, periodId: string): string {
  return `${QUOTA_PREFIX}${keyId}:${periodId}`;
}

/** SHA-256 of a purchase token, hex. The token itself is never stored. */
export function purchaseTokenHash(purchaseToken: string): Promise<string> {
  return sha256Hex(purchaseToken);
}

/** Reads and parses a JSON value, treating a miss or a torn value as "absent". */
async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.warn(`kv: value at ${key.replace(/:(.{8}).*/, ":$1…")} was not JSON; treating as absent`);
    return null;
  }
}

export async function getKeyRecord(kv: KVNamespace, keyId: string): Promise<KeyRecord | null> {
  return readJson<KeyRecord>(kv, keyRecordKey(keyId));
}

export async function putKeyRecord(kv: KVNamespace, record: KeyRecord): Promise<void> {
  await kv.put(keyRecordKey(record.keyId), JSON.stringify(record));
}

export async function getPurchaseRecord(kv: KVNamespace, tokenHash: string): Promise<PurchaseRecord | null> {
  return readJson<PurchaseRecord>(kv, purchaseRecordKey(tokenHash));
}

export async function putPurchaseRecord(kv: KVNamespace, record: PurchaseRecord): Promise<void> {
  await kv.put(purchaseRecordKey(record.tokenHash), JSON.stringify(record));
}

export async function deletePurchaseRecord(kv: KVNamespace, tokenHash: string): Promise<void> {
  await kv.delete(purchaseRecordKey(tokenHash));
}

/**
 * Resolves a presented virtual key to its record.
 *
 * The presented key is hashed and looked up, then the record's own id is compared against that
 * hash before the record is returned. A revoked or expired record is treated as absent: the slot
 * still exists as a tombstone (so `/api/subscription-status` on a dead key cannot report a live
 * plan) but the credential stops working the moment the state says so.
 */
export async function findKeyByVirtualKey(kv: KVNamespace, virtualKey: string): Promise<KeyRecord | null> {
  const keyId = await sha256Hex(virtualKey);
  const record = await getKeyRecord(kv, keyId);
  if (record === null) return null;
  if (record.keyId !== keyId) {
    console.error("kv: key record id does not match its slot — refusing");
    return null;
  }
  if (record.status === STATUS.REVOKED) return null;
  return record;
}

/**
 * Reads the present period's counter, creating a zeroed snapshot from the limit when absent.
 *
 * Note: All consumer and business licence keys are metered in the `LicenceMeter` Durable Object.
 * This KV counter is retained only for Play-provisioned keys without a `licenceId`, and never
 * performs `kv.list` delta scans.
 */
export async function readQuota(
  kv: KVNamespace,
  keyId: string,
  limitTokens: number,
  now: number,
): Promise<QuotaSnapshot> {
  const periodId = periodIdFor(now);
  const record = await readJson<QuotaRecord>(kv, quotaRecordKey(keyId, periodId));
  const usedTokens = record?.usedTokens ?? 0;
  const renewsAt = record && record.renewsAt > 0 ? record.renewsAt : periodRenewsAt(now);

  return quotaSnapshot({
    periodId,
    usedTokens,
    // The live var wins over a stored limit: changing the plan's allowance must not require a
    // migration, and a stale stored value must not let an old limit persist forever.
    limitTokens,
    renewsAt,
  });
}

export type UsageWriteOutcome = {
  snapshot: QuotaSnapshot;
  persisted: boolean;
};

const quotaWriteChains = new Map<string, Promise<unknown>>();

/**
 * Adds this request's tokens to the period counter and returns the new snapshot.
 *
 * Licence-backed keys (`record.licenceId`) use `LicenceMeter.recordSpend` instead. This function
 * updates the single `quota:<keyId>:<periodId>` KV record for Play-backed keys without writing
 * per-request `quota:usage:*` delta keys.
 */
export async function recordUsage(
  kv: KVNamespace,
  keyId: string,
  limitTokens: number,
  promptTokens: number,
  completionTokens: number,
  now: number,
): Promise<UsageWriteOutcome> {
  const periodId = periodIdFor(now);
  const promptDelta = Math.max(0, Math.floor(promptTokens) || 0);
  const completionDelta = Math.max(0, Math.floor(completionTokens) || 0);
  const totalDelta = promptDelta + completionDelta;

  if (totalDelta === 0) {
    const current = await readQuota(kv, keyId, limitTokens, now);
    return { snapshot: current, persisted: false };
  }

  const lockKey = quotaRecordKey(keyId, periodId);
  const previous = quotaWriteChains.get(lockKey) ?? Promise.resolve();

  const task = previous.then(async (): Promise<UsageWriteOutcome> => {
    try {
      const current = await readQuota(kv, keyId, limitTokens, now);
      const nextUsed = current.usedTokens + totalDelta;
      const updatedSnapshot = quotaSnapshot({
        periodId,
        usedTokens: nextUsed,
        limitTokens: current.limitTokens,
        renewsAt: current.renewsAt,
      });
      const record: QuotaRecord = {
        keyId,
        periodId,
        usedTokens: updatedSnapshot.usedTokens,
        limitTokens: updatedSnapshot.limitTokens,
        renewsAt: updatedSnapshot.renewsAt,
        updatedAt: now,
      };
      await kv.put(lockKey, JSON.stringify(record));
      await rememberPeriod(kv, periodId);
      return { snapshot: updatedSnapshot, persisted: true };
    } catch (error) {
      console.error(
        `kv: failed to persist quota for key ${shortId(keyId)} period ${periodId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const fallback = await readQuota(kv, keyId, limitTokens, now);
      return { snapshot: fallback, persisted: false };
    }
  });

  quotaWriteChains.set(
    lockKey,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

/**
 * The result of binding a device to a key.
 *
 * `same_device` and `new_device` both mean "provision allowed"; `limit_reached` means the
 * subscription already has `GESTU_DEVICE_LIMIT` devices. Re-provisioning an existing device
 * refreshes its `lastSeenAt` and consumes no slot, which is what makes a reinstall or a
 * re-launch after clearing app data work.
 */
export type DeviceBindOutcome =
  | { kind: "same_device"; record: KeyRecord }
  | { kind: "new_device"; record: KeyRecord }
  | { kind: "limit_reached"; limit: number };

export async function bindDevice(input: {
  kv: KVNamespace;
  record: KeyRecord;
  deviceId: string;
  deviceLimit: number;
  now: number;
}): Promise<DeviceBindOutcome> {
  const { kv, record, deviceId, deviceLimit, now } = input;
  const devices = Array.isArray(record.devices) ? record.devices : [];
  const existing = devices.find((device) => device.deviceId === deviceId);
  if (existing !== undefined) {
    const updated: KeyRecord = {
      ...record,
      devices: devices.map((device) =>
        device.deviceId === deviceId ? { ...device, lastSeenAt: now } : device,
      ),
    };
    await putKeyRecord(kv, updated);
    return { kind: "same_device", record: updated };
  }
  // A limit of zero or less means no cap — what a business licence with unlimited seats asks for.
  // Written as a condition on the limit rather than by handing this a huge number: a sentinel like
  // `Number.MAX_SAFE_INTEGER` reads like a mistake, and "no cap" deserves a name.
  if (deviceLimit > 0 && devices.length >= deviceLimit) {
    return { kind: "limit_reached", limit: deviceLimit };
  }
  const updated: KeyRecord = {
    ...record,
    devices: [...devices, { deviceId, firstSeenAt: now, lastSeenAt: now }],
  };
  await putKeyRecord(kv, updated);
  return { kind: "new_device", record: updated };
}

/**
 * The device cap that applies to one key.
 *
 * The record's own value when it has one, and the deployment's configured limit otherwise — which
 * is every Play subscription and every record written before the field existed.
 */
export function deviceLimitFor(record: KeyRecord, configuredLimit: number): number {
  return record.deviceLimit ?? configuredLimit;
}

/** Creates a key record for a freshly verified purchase. */
export function newKeyRecord(input: {
  keyId: string;
  packageName: string;
  productId: string;
  obfuscatedAccountId: string;
  expiresAt: number;
  status: SubscriptionStatusId;
  playState: string;
  latestOrderId: string;
  deviceId: string;
  /** Devices this key may serve; `0` means no cap. See [KeyRecord.deviceLimit]. */
  deviceLimit: number;
  now: number;
}): KeyRecord {
  return {
    keyId: input.keyId,
    purchaseTokenHashes: [],
    devices: [{ deviceId: input.deviceId, firstSeenAt: input.now, lastSeenAt: input.now }],
    deviceLimit: input.deviceLimit,
    obfuscatedAccountId: input.obfuscatedAccountId,
    packageName: input.packageName,
    productId: input.productId,
    expiresAt: input.expiresAt,
    status: input.status,
    playState: input.playState,
    latestOrderId: input.latestOrderId,
    updatedAt: input.now,
    revokedAt: 0,
  };
}

/** Adds a purchase token hash to a key's list, keeping it unique. */
export function linkPurchaseTokenHash(record: KeyRecord, tokenHash: string): KeyRecord {
  const hashes = Array.isArray(record.purchaseTokenHashes) ? record.purchaseTokenHashes : [];
  if (hashes.includes(tokenHash)) return record;
  return { ...record, purchaseTokenHashes: [...hashes, tokenHash] };
}

/**
 * Marks a key revoked and removes its purchase pointers.
 *
 * The key *record* is deleted as well as the purchase index entries: a revoked or expired
 * subscription must not be able to answer `/api/subscription-status` from a stale record, and
 * deleting the index entries is what makes a later re-purchase mint a fresh key instead of
 * resurrecting the old one.
 */
export async function revokeKey(kv: KVNamespace, keyId: string, status: SubscriptionStatusId, now: number): Promise<void> {
  const record = await getKeyRecord(kv, keyId);
  if (record !== null) {
    for (const tokenHash of record.purchaseTokenHashes ?? []) {
      await deletePurchaseRecord(kv, tokenHash);
    }
    // Keep a tombstone: the slot still holds the record (so `/api/subscription-status` can explain
    // *why* the key stopped), but `findKeyByVirtualKey` refuses a revoked record, so the credential
    // is dead the moment this runs.
    const tombstone: KeyRecord = {
      ...record,
      status,
      revokedAt: now,
      updatedAt: now,
      purchaseTokenHashes: [],
      devices: [],
    };
    await kv.put(keyRecordKey(keyId), JSON.stringify(tombstone));
  }
  await removeActiveKey(kv, keyId);
}

/** Applies a status/expiry change from Play (RTDN or a fresh verification). */
export async function updateKeyStatus(
  kv: KVNamespace,
  keyId: string,
  patch: Partial<Pick<KeyRecord, "status" | "expiresAt" | "playState" | "latestOrderId">>,
  now: number,
): Promise<KeyRecord | null> {
  const record = await getKeyRecord(kv, keyId);
  if (record === null) return null;
  const updated: KeyRecord = { ...record, ...patch, updatedAt: now };
  await putKeyRecord(kv, updated);
  return updated;
}

// ---------------------------------------------------------------------------------------------
// Maintenance index
// ---------------------------------------------------------------------------------------------

/**
 * Records a key id in the maintenance index.
 *
 * Best-effort: a failure here costs a prune opportunity, never access.
 */
export async function rememberActiveKey(kv: KVNamespace, keyId: string): Promise<void> {
  await mutateIndex(kv, (index) => {
    if (index.keyIds.includes(keyId)) return null;
    if (index.keyIds.length >= MAX_INDEXED_KEYS) {
      console.warn("kv: maintenance index is full; pruning will skip new keys until it is pruned");
      return null;
    }
    return { ...index, keyIds: [...index.keyIds, keyId] };
  });
}

/**
 * Records that this caller wrote (or read) a counter for `periodId`.
 *
 * Called from the metering path, so it runs once per metered request — one extra KV read. That is
 * the price of teaching the prune which periods exist instead of having it blind-delete twelve
 * keys per stored key every month.
 */
export async function rememberPeriod(kv: KVNamespace, periodId: string): Promise<void> {
  await mutateIndex(kv, (index) => {
    if (index.periods.includes(periodId)) return null;
    const periods = [...index.periods, periodId].slice(-MAX_INDEXED_PERIODS);
    return { ...index, periods };
  });
}

export async function removeActiveKey(kv: KVNamespace, keyId: string): Promise<void> {
  await mutateIndex(kv, (index) => {
    if (!index.keyIds.includes(keyId)) return null;
    return { ...index, keyIds: index.keyIds.filter((entry) => entry !== keyId) };
  });
}

export async function readMaintenanceIndex(kv: KVNamespace): Promise<MaintenanceIndex> {
  const raw = await kv.get(ACTIVE_KEYS_KEY);
  if (raw === null) return EMPTY_INDEX;
  try {
    const parsed = JSON.parse(raw) as Partial<MaintenanceIndex>;
    return {
      keyIds: Array.isArray(parsed.keyIds) ? parsed.keyIds.filter((id) => typeof id === "string") : [],
      periods: Array.isArray(parsed.periods) ? parsed.periods.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return EMPTY_INDEX;
  }
}

/**
 * Read-modify-writes the index.
 *
 * `mutate` returns `null` to mean "no change needed", which skips the write entirely — the index
 * is touched on the first request of a period and on each new key, not on every request.
 */
async function mutateIndex(
  kv: KVNamespace,
  mutate: (index: MaintenanceIndex) => MaintenanceIndex | null,
): Promise<void> {
  try {
    const current = await readMaintenanceIndex(kv);
    const next = mutate(current);
    if (next === null) return;
    await kv.put(ACTIVE_KEYS_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn(
      `kv: could not update the maintenance index (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Short, non-reversible id for log lines about a key. */
export function shortId(keyId: string): string {
  return `key:${keyId.slice(0, 8)}`;
}
