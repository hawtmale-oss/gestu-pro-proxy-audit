/**
 * The Free managed route: `POST /api/provision-free-token`, plus the anti-abuse limits that keep a
 * no-purchase credential from becoming an unbounded bill.
 *
 * ## Why a separate route rather than a "free product" on the Play path
 *
 * The Play path's whole security model is "Google says this purchase is real". A Free key has no
 * purchase, so there is nothing for Google to verify and nothing a client can prove. What is left
 * is a **device-bound** credential with a per-device monthly allowance, minted only when the caller
 * asks for one, and protected by rate limits rather than by a receipt:
 *
 *  * `POST /api/provision-free-token` → a `gsk_` virtual key, stored only as `sha256`, with
 *    `productId = "gestu_free"` and a stable `meterId` derived from the device id;
 *  * the **meterId** is what makes "200,000 output tokens per device per month" true even across a
 *    reinstall: the secret rotates, the meter does not reset;
 *  * Cloudflare sees the caller's IP, so every limit is keyed by `sha256(IP + deviceId)` — device
 *    id alone is forgeable by a script, IP alone breaks a household behind one NAT;
 *  * the limits are two-window (short = burst, long = allowance cycling), and they **fail closed**:
 *    a counter that cannot be read or written refuses the request with a `429` instead of guessing.
 *
 * Nothing here holds or returns a provider key. The app never sees the upstream credential; the
 * Free model id it asks for is a public model family name, not a secret.
 */

import { mintVirtualKey, sha256Hex } from "./base64";
import type { Env, FreeRateLimiterBinding, ProxyConfig } from "./config";
import { isBlockedRequest } from "./blocked";
import { isExemptRequest } from "./exempt";
import { periodIdFor } from "./quota";
import { readAccessMeter, readFreeIpRateLimiter, readFreeRateLimiter } from "./config";
import {
  DENIAL,
  FREE_CHAT_DAILY_RATE_LIMIT,
  FREE_CHAT_DAILY_WINDOW_MS,
  FREE_CHAT_RATE_LIMIT,
  FREE_CHAT_RATE_WINDOW_MS,
  FREE_DATACENTER_IP_PROVISION_RATE_LIMIT,
  FREE_IP_CHAT_DAILY_RATE_LIMIT,
  FREE_IP_CHAT_RATE_LIMIT,
  FREE_IP_PROVISION_RATE_LIMIT,
  FREE_MONTHLY_OUTPUT_TOKENS,
  FREE_PROVISION_RATE_LIMIT,
  FREE_PROVISION_RATE_WINDOW_MS,
  FREE_TRIAL_WINDOW_DAYS,
  FREE_TRIAL_WINDOW_MS,
  PLAN_FREE,
  PRODUCT_ID_FREE,
  STATUS,
  tierForProductId,
} from "./constants";
import { DEFAULT_FREE_MONTHLY_CAP_MICRO_USD } from "./cost";
import { recordFunnelEvent } from "./funnel";
import { callLicenceMeter, hasLiveLicenceMeter } from "./licence-meter";
import type { LicenceUsageSummary } from "./licence-meter";
import { periodRenewsAt, readTierUsage } from "./quota";
import type { ProvisionResponse } from "./provision";
import { markSupersededKeyDead } from "./provision";
import { badRequest, jsonResponse } from "./responses";
import {
  getKeyRecord,
  newKeyRecord,
  putKeyRecord,
  rememberActiveKey,
  revokeKey,
  shortId,
} from "./store";
import type { KeyRecord } from "./store";

/** A Free key's stable metering id. Prefixed so a KV key dump names what it is. */
export const FREE_DEVICE_METER_PREFIX = "free-device:";

/** The app's `ProFreeTokenRequest` (`com.gestu.app.pro.ProFreeTokenRequest`), as sent on the wire. */
export interface FreeTokenRequest {
  deviceId: string;
  packageName: string;
  appVersion: string;
}

/** The app's `ProProvisionResponse`, plus the Free route's quota snapshot fields. */
export interface FreeTokenResponse extends ProvisionResponse {
  licenceToken: string;
  licenceId: string;
  plan: string;
  status: string;
  periodEnd: number;
  quotaPeriod: string;
  quotaUsed: number;
  quotaLimit: number;
  quotaRenewsAt: number;
  quotaMode: string;
  devicesUsed: number;
  deviceLimit: number;
}

/**
 * Parses the body without trusting a field's type.
 *
 * `deviceId` is required (the route exists to bind a device); `packageName` and `appVersion` are
 * optional exactly as the Kotlin defaults declare, so a build without the field still provisions.
 */
export function parseFreeTokenRequest(raw: unknown): FreeTokenRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("body must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  return {
    deviceId: typeof record["deviceId"] === "string" ? record["deviceId"].trim().slice(0, 256) : "",
    packageName: typeof record["packageName"] === "string" ? record["packageName"].trim().slice(0, 256) : "",
    appVersion: typeof record["appVersion"] === "string" ? record["appVersion"].slice(0, 128) : "",
  };
}

/**
 * The stable per-device metering id.
 *
 * Not the key id: the secret rotates on every re-provision (only its hash can be stored), and a
 * meter keyed by the secret would hand the device a fresh 200,000-token allowance on each reinstall.
 * Hashing the device id keeps the reading stable and keeps the raw device id out of KV keys.
 */
/** New Free devices one IP may keep per UTC month (`GESTU_FREE_DEVICES_PER_IP_MONTH`, default 2). */
export const DEFAULT_FREE_NEW_DEVICES_PER_IP_MONTH = 2;
export function freeNewDevicesPerIpMonth(env: Env): number {
  const raw = Number.parseInt((env as unknown as Record<string, string | undefined>)["GESTU_FREE_DEVICES_PER_IP_MONTH"] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FREE_NEW_DEVICES_PER_IP_MONTH;
}

/** One Free device remembered against an IP, newest last. */
interface FreeIpDevice {
  deviceHash: string;
  keyId: string;
}

/** Ordered devices per IP/month. The oldest is evicted when a new one would exceed the cap. */
export function freeIpDevicesKey(ipIdentity: string, periodId: string): string {
  return `free-ip-devices:${ipIdentity}:${periodId}`;
}

/**
 * Reads the IP's device list, treating a missing or malformed value as empty.
 *
 * The list is an ordered queue, not a counter: the eviction policy needs to know which permission
 * is oldest, and a bare number cannot answer that.
 */
async function readFreeIpDevices(env: Env, key: string): Promise<FreeIpDevice[]> {
  try {
    const raw = await env.PRO_KV.get(key);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is FreeIpDevice =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as FreeIpDevice).deviceHash === "string" &&
        typeof (entry as FreeIpDevice).keyId === "string",
      )
      .map((entry) => ({ deviceHash: entry.deviceHash, keyId: entry.keyId }));
  } catch {
    return [];
  }
}

/**
 * Revokes one evicted device's Free permission.
 *
 * The credential is killed in the same way a purchase-backed key is: a revoked tombstone keeps the
 * status endpoint able to explain why, while `findKeyByVirtualKey` refuses it. The device index is
 * deleted so a later reinstall of that device is treated as a new device (and evicts the next
 * oldest), rather than resurrecting the dead key.
 */
async function evictFreeDevice(env: Env, entry: FreeIpDevice, now: number): Promise<void> {
  await revokeKey(env.PRO_KV, entry.keyId, STATUS.REVOKED, now);
  const indexKey = freeDeviceIndexKey(entry.deviceHash);
  if ((await env.PRO_KV.get(indexKey)) === entry.keyId) {
    await env.PRO_KV.delete(indexKey);
  }
  console.log(
    `provision-free: evicted oldest Free device ${entry.deviceHash.slice(0, 8)} for this IP`,
  );
}

export function freeMeterIdForDevice(deviceId: string): Promise<string> {
  return sha256Hex(`${FREE_DEVICE_METER_PREFIX}${deviceId}`).then((hash) => `${FREE_DEVICE_METER_PREFIX}${hash}`);
}

/** KV slot that points a device back at its current Free key, so a reinstall rotates one key. */
export function freeDeviceIndexKey(deviceHash: string): string {
  return `free:device:${deviceHash}`;
}

/** KV slot recording the epoch ms a device's Free trial first started (stable across reinstalls). */
export function freeTrialStartKey(deviceHash: string): string {
  return `free:trial:${deviceHash}`;
}

/** Free trial window duration in ms (`GESTU_FREE_TRIAL_DAYS`, default 7 days). */
export function freeTrialWindowMs(env: Env): number {
  const raw = Number.parseInt(
    (env as unknown as Record<string, string | undefined>)["GESTU_FREE_TRIAL_DAYS"] ?? "",
    10,
  );
  return Number.isFinite(raw) && raw > 0 ? raw * 86_400_000 : FREE_TRIAL_WINDOW_MS;
}

export { FREE_TRIAL_WINDOW_DAYS };

/**
 * Retires a device's Free credential and Free-meter seat when that same `deviceId` upgrades to
 * Pro (Play subscription, B2B licence, or direct activation code).
 *
 * Linking Free and Pro through one persistent `deviceId` ensures the same install is never counted
 * twice — once as an active Free device and again as a Pro seat. Only a live `PRODUCT_ID_FREE`
 * record is ever touched here; if the device never used Free (or its Free key was already revoked),
 * this is a safe no-op.
 */
export async function retireFreeDeviceOnProUpgrade(
  env: Env,
  deviceId: string,
  now: number,
): Promise<{ retiredFreeKeyId: string | null; freeMeterId: string | null }> {
  const normalized = deviceId.trim();
  if (normalized === "") return { retiredFreeKeyId: null, freeMeterId: null };
  const deviceHash = await sha256Hex(normalized);
  const indexKey = freeDeviceIndexKey(deviceHash);
  const indexedKeyId = await env.PRO_KV.get(indexKey);
  if (indexedKeyId === null) return { retiredFreeKeyId: null, freeMeterId: null };

  const existing = await getKeyRecord(env.PRO_KV, indexedKeyId);
  if (existing === null || existing.productId !== PRODUCT_ID_FREE || existing.status === STATUS.REVOKED) {
    return { retiredFreeKeyId: null, freeMeterId: null };
  }

  await revokeKey(env.PRO_KV, existing.keyId, STATUS.REVOKED, now);
  if ((await env.PRO_KV.get(indexKey)) === existing.keyId) {
    await env.PRO_KV.delete(indexKey);
  }
  const freeMeterId = existing.meterId || (await freeMeterIdForDevice(normalized));
  if (hasLiveLicenceMeter(env)) {
    await callLicenceMeter(env.LICENCE_METER, freeMeterId, "releaseDevice", {
      licenceId: freeMeterId,
      deviceId: normalized,
      now,
    });
  }
  console.log(
    `provision-upgrade: retired Free key ${shortId(existing.keyId)} for device ${deviceHash.slice(0, 8)} on Pro upgrade`,
  );
  return { retiredFreeKeyId: existing.keyId, freeMeterId };
}

/** The caller's IP as Cloudflare reports it. Empty when the header is absent (local dev). */
export function clientIp(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct !== null && direct.trim() !== "") return direct.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first !== "") return first;
  }
  return "";
}

/** One rate-limit decision. Denials always carry how long the caller should wait. */
export type FreeRateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: string };

/**
 * Consumes one slot from a fixed-window KV counter, or refuses.
 *
 * The KV read-modify-write is not atomic, so concurrent calls can under-count by the number of
 * requests that raced — acceptable for an anti-abuse throttle and documented as such. What is *not*
 * acceptable is failing open, so any KV error denies.
 *
 * The optional Cloudflare `ratelimit` binding is used for the short window when it is bound: it is
 * a per-colo token bucket with better burst behaviour than a KV counter and it removes the KV
 * round-trip from the hot path. The binding cannot express windows longer than a minute, so the
 * long window is always the KV counter.
 */
export async function consumeFreeRateLimit(input: {
  env: Env;
  scope: string;
  identity: string;
  max: number;
  windowMs: number;
  now: number;
  useBinding?: boolean;
  /**
   * The binding to consult for this scope. When supplied (and the window is a short one), it is
   * authoritative and nothing is written to KV — see the comment on the early return below.
   */
  binding?: FreeRateLimiterBinding;
  /**
   * Day-window object for this scope. When supplied, the long window's counter lives in the
   * Durable Object instead of KV, so the request costs no KV write at all.
   */
  dayMeter?: DurableObjectNamespace;
}): Promise<FreeRateDecision> {
  const { env, scope, identity, max, windowMs, now, useBinding = true } = input;
  const bucket = Math.floor(now / windowMs);
  const retryAfterSeconds = Math.max(1, Math.ceil(((bucket + 1) * windowMs - now) / 1000));

  const limiter = input.binding ?? (useBinding && windowMs <= 60_000 ? readFreeRateLimiter(env) : undefined);
  if (limiter !== undefined && windowMs <= 60_000) {
    try {
      const { success } = await limiter.limit({ key: `${scope}:${identity}` });
      if (!success) return { allowed: false, retryAfterSeconds, scope };
      // The binding answered this window, so the KV counter would only duplicate it. Every KV
      // write spends the account's daily quota, and on the free plan 1,000 writes/day is roughly
      // 250 metered requests: paying one write per request to re-decide a window that was just
      // decided is what took the whole route down. Return without touching KV.
      return { allowed: true };
    } catch (error) {
      // A limiter that cannot answer is a limiter we cannot trust: refuse.
      console.error(
        `free: ratelimit binding failed for ${scope} (${error instanceof Error ? error.message : String(error)}) — failing closed`,
      );
      return { allowed: false, retryAfterSeconds, scope };
    }
  }

  if (input.dayMeter !== undefined && windowMs > 60_000) {
    // The day window, counted by a single-writer Durable Object instead of a KV read-modify-write:
    // exact rather than best-effort, and — the point of the move — it costs no KV write, which on
    // the free plan is the resource the whole product is bounded by.
    try {
      const id = input.dayMeter.idFromName(`${scope}:${identity}`);
      const res = await input.dayMeter.get(id).fetch("https://access-meter/hit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ windowMs, max, now }),
      });
      const outcome = (await res.json()) as { allowed: boolean; retryAfterSeconds: number };
      return outcome.allowed
        ? { allowed: true }
        : { allowed: false, retryAfterSeconds: outcome.retryAfterSeconds, scope };
    } catch (error) {
      // Same posture as the KV counter: a limiter that cannot answer must refuse.
      console.error(
        `free: day meter failed for ${scope} (${error instanceof Error ? error.message : String(error)}) — failing closed`,
      );
      return { allowed: false, retryAfterSeconds, scope };
    }
  }

  const counterKey = `rl:${scope}:${bucket}:${identity}`;
  try {
    const raw = await env.PRO_KV.get(counterKey);
    const used = raw === null ? 0 : Number(raw);
    const usedCount = Number.isFinite(used) && used > 0 ? Math.floor(used) : 0;
    if (usedCount >= max) {
      return { allowed: false, retryAfterSeconds, scope };
    }
    await env.PRO_KV.put(counterKey, String(usedCount + 1), {
      expirationTtl: retryAfterSeconds + 60,
    });
    return { allowed: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // An account that has spent its daily KV quota cannot answer *any* counter, so failing closed
    // here converts a Cloudflare account limit into a total outage of the managed route: every
    // request, Free and Pro alike, is refused before it is even metered. A closed route is not a
    // safe failure — it is the whole product. Let the request through uncounted and log it, so the
    // window degrades to "not enforced" until the quota resets.
    if (isKvQuotaExhausted(message)) {
      console.error(`free: KV quota exhausted, allowing ${scope} uncounted (${message})`);
      return { allowed: true };
    }
    console.error(`free: rate-limit counter failed for ${scope} (${message}) — failing closed`);
    return { allowed: false, retryAfterSeconds, scope };
  }
}

/**
 * True when a KV failure is the account's usage quota rather than a transient fault.
 *
 * The daily-free-tier rejection surfaces as an API error carrying `10048` / "free usage limit", and
 * some paths only forward the HTTP `429`. Any of those means "this namespace cannot count anything
 * today", which is the one case where refusing every request is worse than not enforcing.
 */
function isKvQuotaExhausted(message: string): boolean {
  return /10048|free usage limit|too many requests/i.test(message);
}

/** Normalises the provisioning IP+device pair into one opaque limiter identity. */
export async function freeLimiterIdentity(request: Request, deviceId: string): Promise<string> {
  return sha256Hex(`free|${clientIp(request)}|${deviceId}`);
}

/** Normalises the caller IP alone so cycling deviceIds from one IP stays bounded. */
export async function freeIpLimiterIdentity(request: Request): Promise<string> {
  return sha256Hex(`free-ip|${clientIp(request)}`);
}

const DATACENTER_ASN_KEYWORDS = [
  "amazon",
  "aws",
  "digitalocean",
  "hetzner",
  "ovh",
  "linode",
  "akamai connected cloud",
  "vultr",
  "choopa",
  "contabo",
  "scaleway",
  "alibaba",
  "tencent",
  "oracle cloud",
  "leaseweb",
];

/**
 * Detects automated bot-farm or cloud/VPS datacenter requests via Cloudflare edge metadata.
 */
export function isSuspectedBotFarmRequest(request: Request): { botScoreLow: boolean; datacenterAsn: boolean } {
  const cf = (
    request as Request & {
      cf?: { asOrganization?: string; botManagement?: { score?: number } };
    }
  ).cf;
  if (!cf || typeof cf !== "object") {
    return { botScoreLow: false, datacenterAsn: false };
  }
  const botScore = cf.botManagement?.score;
  const botScoreLow = typeof botScore === "number" && botScore > 0 && botScore < 10;
  const org = (cf.asOrganization ?? "").toLowerCase();
  const datacenterAsn =
    org !== "" && DATACENTER_ASN_KEYWORDS.some((kw) => org.includes(kw));
  return { botScoreLow, datacenterAsn };
}

/** Rate-limit `POST /api/provision-free-token`: 12/IP+device/hr AND 36/IP/hr. */
export async function checkFreeProvisionRateLimit(
  env: Env,
  identity: string,
  now: number,
  ipIdentity?: string,
): Promise<FreeRateDecision> {
  const perDevice = await consumeFreeRateLimit({
    env,
    scope: "free-provision",
    identity,
    max: FREE_PROVISION_RATE_LIMIT,
    windowMs: FREE_PROVISION_RATE_WINDOW_MS,
    now,
  });
  if (!perDevice.allowed || !ipIdentity) return perDevice;
  return consumeFreeRateLimit({
    env,
    scope: "free-provision-ip",
    identity: ipIdentity,
    max: FREE_IP_PROVISION_RATE_LIMIT,
    windowMs: FREE_PROVISION_RATE_WINDOW_MS,
    now,
  });
}

/**
 * Rate-limit Free inference: per-IP+device (100/min, 100/day) AND per-IP ceilings (200/min, 300/day)
 * so rotating device IDs on one IP cannot multiply the burst or daily cap unboundedly.
 */
export async function checkFreeChatRateLimit(
  env: Env,
  identity: string,
  now: number,
  ipIdentity?: string,
): Promise<FreeRateDecision> {
  const perMinute = await consumeFreeRateLimit({
    env,
    scope: "free-chat-minute",
    identity,
    max: FREE_CHAT_RATE_LIMIT,
    windowMs: FREE_CHAT_RATE_WINDOW_MS,
    now,
  });
  if (!perMinute.allowed) return perMinute;
  const perDay = await consumeFreeRateLimit({
    env,
    scope: "free-chat-day",
    identity,
    max: FREE_CHAT_DAILY_RATE_LIMIT,
    windowMs: FREE_CHAT_DAILY_WINDOW_MS,
    now,
    dayMeter: readAccessMeter(env),
  });
  if (!perDay.allowed || !ipIdentity) return perDay;
  const ipPerMinute = await consumeFreeRateLimit({
    env,
    scope: "free-chat-ip-minute",
    identity: ipIdentity,
    max: FREE_IP_CHAT_RATE_LIMIT,
    windowMs: FREE_CHAT_RATE_WINDOW_MS,
    now,
    // Its own binding: the IP ceiling (90) differs from the per-device one (60), and a binding
    // carries a single limit.
    binding: readFreeIpRateLimiter(env),
  });
  if (!ipPerMinute.allowed) return ipPerMinute;
  return consumeFreeRateLimit({
    env,
    scope: "free-chat-ip-day",
    identity: ipIdentity,
    max: FREE_IP_CHAT_DAILY_RATE_LIMIT,
    windowMs: FREE_CHAT_DAILY_WINDOW_MS,
    now,
    dayMeter: readAccessMeter(env),
  });
}

function freeResponse(partial: Partial<FreeTokenResponse> & { ok: boolean }): FreeTokenResponse {
  return {
    virtualKey: "",
    proxyBaseUrl: "",
    expiresAt: 0,
    licenceToken: "",
    licenceId: "",
    plan: PLAN_FREE,
    status: "",
    periodEnd: 0,
    quotaPeriod: "",
    quotaUsed: 0,
    quotaLimit: FREE_MONTHLY_OUTPUT_TOKENS,
    quotaRenewsAt: 0,
    quotaMode: "normal",
    devicesUsed: 0,
    deviceLimit: 1,
    reason: "",
    message: "",
    ...partial,
  };
}

/**
 * `POST /api/provision-free-token` — mint (or rotate) the device-bound Free managed key.
 *
 * A refusal is a `200 {ok:false, reason}` in the same vocabulary as the Play path (`not_verified`,
 * `invalid_token`, `rate_limited`), because the client distinguishes "the server said no" from
 * "the network failed" and recovers differently. The one exception is the rate limit, which is a
 * `429` with `Retry-After`: it is transient by definition, so the client should retry later rather
 * than treat the device as refused forever.
 */
export async function handleProvisionFreeToken(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now = Date.now(),
): Promise<Response> {
  let parsed: FreeTokenRequest;
  try {
    parsed = parseFreeTokenRequest(await request.json());
  } catch (error) {
    if (error instanceof Error && error.name === "HttpError") throw error;
    throw badRequest("body must be JSON");
  }

  if (parsed.deviceId === "") throw badRequest("deviceId is required");

  // Reject missing or unrecognised package names so automated scripts cannot omit packageName.
  if (parsed.packageName === "" || !config.allowedPackageNames.includes(parsed.packageName)) {
    console.warn(`provision-free: refused package ${parsed.packageName || "(empty)"}`);
    return jsonResponse(
      freeResponse({
        ok: false,
        reason: DENIAL.NOT_VERIFIED,
        message: "This app is not allowed to use the Gestu Free managed route.",
      }),
    );
  }

  // Ban list, before anything is minted or counted: a revoked key alone would let the device ask
  // for a fresh one, which is exactly what a ban has to prevent.
  if (await isBlockedRequest(env, parsed.deviceId, clientIp(request))) {
    console.warn(`provision-free: refused a banned device (${parsed.deviceId.slice(0, 8)}…)`);
    return jsonResponse(
      freeResponse({
        ok: false,
        reason: DENIAL.REVOKED,
        message: "This device is not allowed to use the Gestu Free managed route.",
      }),
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const botSignal = isSuspectedBotFarmRequest(request);
  // Operator exemption: an allow-listed device (or network) is never refused for capacity, and its
  // reinstall does not count against the per-IP new-device cap. Package validation above still
  // applies — that is a contract check, not a limit.
  const exempt = await isExemptRequest(env, parsed.deviceId, clientIp(request));
  if (!exempt && botSignal.botScoreLow) {
    console.warn("provision-free: refused low bot score");
    return jsonResponse(
      freeResponse({
        ok: false,
        reason: DENIAL.RATE_LIMITED,
        message: "Automated requests are not allowed on the Gestu Free route.",
      }),
      { status: 429, headers: { "retry-after": "3600" } },
    );
  }

  const identity = await freeLimiterIdentity(request, parsed.deviceId);
  const ipIdentity = await freeIpLimiterIdentity(request);
  if (!exempt && botSignal.datacenterAsn) {
    const dcLimit = await consumeFreeRateLimit({
      env,
      scope: "free-provision-dc-ip",
      identity: ipIdentity,
      max: FREE_DATACENTER_IP_PROVISION_RATE_LIMIT,
      windowMs: FREE_PROVISION_RATE_WINDOW_MS,
      now,
      useBinding: false,
    });
    if (!dcLimit.allowed) {
      return jsonResponse(
        freeResponse({
          ok: false,
          reason: DENIAL.RATE_LIMITED,
          message: "Too many token requests from this network. Try again later, or use your own API key.",
        }),
        { status: 429, headers: { "retry-after": String(dcLimit.retryAfterSeconds) } },
      );
    }
  }
  if (!exempt) {
    const limit = await checkFreeProvisionRateLimit(env, identity, now, ipIdentity);
    if (!limit.allowed) {
      console.warn(`provision-free: rate limited (${limit.scope})`);
      return jsonResponse(
        freeResponse({
          ok: false,
          reason: DENIAL.RATE_LIMITED,
          message: "Too many token requests from this device. Try again later, or use your own API key meanwhile.",
        }),
        { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
      );
    }
  }

  const deviceHash = await sha256Hex(parsed.deviceId);
  const indexKey = freeDeviceIndexKey(deviceHash);
  const indexedKeyId = await env.PRO_KV.get(indexKey);
  const existing = indexedKeyId === null ? null : await getKeyRecord(env.PRO_KV, indexedKeyId);

  // New Free devices per IP per UTC month. Re-provisioning a device that already has a live Free
  // key is never counted, so a reinstall or key rotation always works. When a genuinely new device
  // would exceed the cap, the oldest permission from this IP is revoked and replaced instead of
  // refusing the newcomer: the cap bounds concurrent trial devices, not the ability to reinstall.
  // Carrier-grade NAT shares one IP across many phones, hence the env override.
  const devicesKey = ipIdentity === "" ? "" : freeIpDevicesKey(ipIdentity, periodIdFor(now));
  const devices = devicesKey === "" ? [] : await readFreeIpDevices(env, devicesKey);
  const existingActive = existing !== null && existing.status !== STATUS.REVOKED;
  if (!exempt && !existingActive && devicesKey !== "") {
    const allowed = freeNewDevicesPerIpMonth(env);
    while (devices.length >= allowed) {
      const evicted = devices.shift();
      if (evicted) await evictFreeDevice(env, evicted, now);
    }
  }

  const meterId = await freeMeterIdForDevice(parsed.deviceId);
  const virtualKey = mintVirtualKey();
  const keyId = await sha256Hex(virtualKey);

  // Per-user 7-day trial window: persisted once per device hash so a reinstall rotates the secret
  // without ever resetting the 7-day trial clock.
  const trialKey = freeTrialStartKey(deviceHash);
  const storedTrialStartRaw = await env.PRO_KV.get(trialKey);
  const parsedTrialStart = storedTrialStartRaw !== null ? Number(storedTrialStartRaw) : NaN;
  const isNewTrial = !Number.isFinite(parsedTrialStart) || parsedTrialStart <= 0;
  const trialStartedAt = isNewTrial ? now : parsedTrialStart;
  if (isNewTrial) {
    await env.PRO_KV.put(trialKey, String(trialStartedAt));
  }
  const trialExpiresAt = trialStartedAt + freeTrialWindowMs(env);

  const base = newKeyRecord({
    keyId,
    // A Free key is not bought in a store; the record says which app asked for it, when it does.
    packageName: parsed.packageName,
    productId: PRODUCT_ID_FREE,
    obfuscatedAccountId: "",
    // Per-user 7-day trial window (paired with the $0.50 per-user cost cap).
    expiresAt: trialExpiresAt,
    status: STATUS.ACTIVE,
    playState: "",
    latestOrderId: "",
    deviceId: parsed.deviceId,
    // One device, one Free allowance. A second device is a second allowance, not a second seat.
    deviceLimit: 1,
    now,
  });
  const liveDo = hasLiveLicenceMeter(env);
  const record: KeyRecord = {
    ...base,
    meterId,
    trialStartedAt,
    ...(liveDo ? { licenceId: meterId, monthlyCapMicroUsd: DEFAULT_FREE_MONTHLY_CAP_MICRO_USD } : {}),
  };

  if (liveDo) {
    await callLicenceMeter(env.LICENCE_METER, meterId, "upsertDevice", {
      licenceId: meterId,
      deviceId: parsed.deviceId,
      keyId,
      status: STATUS.ACTIVE,
      plan: PRODUCT_ID_FREE,
      periodEnd: trialExpiresAt,
      notAfter: trialExpiresAt,
      monthlyCapMicroUsd: DEFAULT_FREE_MONTHLY_CAP_MICRO_USD,
      deviceLimit: 1,
      now,
    });
  }

  await putKeyRecord(env.PRO_KV, record);
  await rememberActiveKey(env.PRO_KV, keyId);
  await rememberActiveKey(env.PRO_KV, meterId);
  await env.PRO_KV.put(indexKey, keyId);

  if (isNewTrial && !exempt) {
    await recordFunnelEvent(env, "trial_started", now);
  }

  // Keep this device in the IP's ordered queue (newest last), so the next newcomer knows which
  // permission is the oldest one to replace. A reinstall updates its own entry rather than
  // appending a duplicate.
  if (!exempt && devicesKey !== "") {
    const entryIndex = devices.findIndex((entry) => entry.deviceHash === deviceHash);
    const entry: FreeIpDevice = { deviceHash, keyId };
    if (entryIndex >= 0) devices[entryIndex] = entry;
    else devices.push(entry);
    await env.PRO_KV.put(devicesKey, JSON.stringify(devices), { expirationTtl: 40 * 86_400 });
  }

  // The old secret is never shown again and a reinstall cannot present it, so leaving it valid
  // would let a backed-up key keep working. Rotation kills the secret; the meter id keeps the
  // device's month intact. Only a Free record is ever rotated from here — the device index is
  // written by this handler alone, but a corrupted index must never let a Free call revoke a
  // purchase-backed key.
  if (existing !== null && existing.keyId !== keyId && existing.productId === PRODUCT_ID_FREE) {
    await markSupersededKeyDead(env, existing.keyId, keyId, now);
    console.log(
      `provision-free: rotated ${shortId(existing.keyId)} → ${shortId(keyId)} for device ${deviceHash.slice(0, 8)}`,
    );
  }

  if (liveDo) {
    const doUsage = await callLicenceMeter<LicenceUsageSummary>(
      env.LICENCE_METER,
      meterId,
      "getUsage",
      { now },
    );
    return jsonResponse(
      freeResponse({
        ok: true,
        virtualKey,
        proxyBaseUrl: config.proxyBaseUrl,
        expiresAt: trialExpiresAt,
        plan: tierForProductId(PRODUCT_ID_FREE),
        status: STATUS.ACTIVE,
        periodEnd: trialExpiresAt,
        quotaPeriod: doUsage.periodId,
        quotaUsed: doUsage.usedPpm,
        quotaLimit: doUsage.limitPpm,
        quotaRenewsAt: doUsage.renewsAt,
        quotaMode: doUsage.mode,
        devicesUsed: 1,
        deviceLimit: 1,
        message: "Managed by Gestu",
      }),
    );
  }

  const quota = await readTierUsage(env.PRO_KV, meterId, now);
  return jsonResponse(
    freeResponse({
      ok: true,
      virtualKey,
      proxyBaseUrl: config.proxyBaseUrl,
      expiresAt: trialExpiresAt,
      plan: tierForProductId(PRODUCT_ID_FREE),
      status: STATUS.ACTIVE,
      periodEnd: trialExpiresAt,
      quotaPeriod: quota.periodId,
      quotaUsed: quota.outputTokens,
      quotaLimit: FREE_MONTHLY_OUTPUT_TOKENS,
      quotaRenewsAt: periodRenewsAt(now),
      quotaMode: "normal",
      devicesUsed: 1,
      deviceLimit: 1,
      message: "Managed by Gestu",
    }),
  );
}

/** The model id the Free route advertises in `GET /v1/models` and accepts from the app. */
export { FREE_MANAGED_MODEL_ID } from "./constants";
