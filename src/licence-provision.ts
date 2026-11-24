/**
 * `POST /api/provision-licence` — the B2B route to the same managed key.
 *
 * A business buys by invoice, the operator signs a licence (see `licence.ts`), and the customer
 * pastes it into Settings. This handler turns that token into the credential the proxy accepts.
 *
 * ## What it shares with the Play path, and what it deliberately does not
 *
 * Shared: the key record, the device binding, the re-provision rotation, and the response shape. A
 * licence holder and a subscriber must be indistinguishable *to the proxy*, or metering, quota,
 * `/api/subscription-status` and revocation would each need two of everything.
 *
 * Not shared: the evidence. The Play path asks Google whether a purchase is real; this one asks
 * mathematics whether the token was signed by the operator's key. That is why it needs no service
 * account and keeps working while Google is unreachable — and equally why a leaked *public* key
 * costs nothing, since it cannot be used to mint anything.
 *
 * ## Failure posture
 *
 * Identical to the Play path. A missing public key refuses everything (`not_verified`); a bad
 * signature is `invalid_token`; a lapsed licence is `expired`; one device too many is
 * `device_limit`. Every refusal is a 200 carrying `ok:false`, because the app treats a non-2xx as
 * retryable and would otherwise re-present a licence that can never work.
 */

import { mintVirtualKey, sha256Hex } from "./base64";
import type { Env, ProxyConfig } from "./config";
import { readLicencePublicKey } from "./config";
import { DENIAL, PRODUCT_ID_BUSINESS, QUOTA_UNIT_PPM, STATUS } from "./constants";
import { DEFAULT_SOFT_CAP_MICRO_USD } from "./cost";
import { isExemptDevice, isExemptIp } from "./exempt";
import { retireFreeDeviceOnProUpgrade } from "./free";
import { recordFunnelEventOnce } from "./funnel";
import {
  licenceDevicePrefix,
  licenceIndexKey,
  licenceRevokedKey,
  UNLIMITED_SEATS,
  verifyLicence,
} from "./licence";
import { callLicenceMeter } from "./licence-meter";
import type { ProvisionResponse } from "./provision";
import { denied, markSupersededKeyDead } from "./provision";
import { badRequest, jsonResponse } from "./responses";
import { getKeyRecord, newKeyRecord, putKeyRecord, rememberActiveKey, revokeKey, shortId } from "./store";
import type { KeyRecord } from "./store";

/** The client's request body. Mirrors `ProLicenceRequest` on the Kotlin side. */
export interface LicenceProvisionRequest {
  /** The pasteable token produced by `tools/issue-licence.mjs`. */
  licence: string;
  /** The app redeeming it. Checked against the same allow list the Play path uses. */
  packageName: string;
  deviceId: string;
  appVersion: string;
}

/**
 * Parses the body without trusting any field's type.
 *
 * Same reasoning as `parseProvisionRequest`: a hostile client can send anything, and a `TypeError`
 * from reading a property of `null` would surface as a 500 that looks like a server bug rather
 * than a bad request. An over-long `licence` is truncated rather than rejected — a token that long
 * is already not one of ours, and `verifyLicence` will say so.
 */
export function parseLicenceProvisionRequest(raw: unknown): LicenceProvisionRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("body must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  return {
    licence: typeof record["licence"] === "string" ? record["licence"].trim().slice(0, 4096) : "",
    packageName: typeof record["packageName"] === "string" ? record["packageName"].trim() : "",
    deviceId: typeof record["deviceId"] === "string" ? record["deviceId"].trim() : "",
    appVersion: typeof record["appVersion"] === "string" ? record["appVersion"] : "",
  };
}

/**
 * Handles the licence provision request.
 *
 * Returns a `Response` for every outcome, refusals included: the client distinguishes "denied"
 * (a 200 with `ok:false`, final) from "failed" (a non-2xx, retryable) and recovers differently
 * from each.
 */
export async function handleProvisionLicence(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now = Date.now(),
): Promise<Response> {
  let parsed: LicenceProvisionRequest;
  try {
    parsed = parseLicenceProvisionRequest(await request.json());
  } catch (error) {
    if (error instanceof Error && error.name === "HttpError") throw error;
    throw badRequest("body must be JSON");
  }

  if (parsed.deviceId === "") throw badRequest("deviceId is required");
  if (parsed.licence === "") {
    return jsonResponse(denied(DENIAL.NOT_VERIFIED, "No licence key was supplied."));
  }
  // The licence is issued to an organisation, not to an app store listing, so the app redeeming it
  // is checked here instead of inside the token. Without this, a licence bought for Gestu could be
  // redeemed by any client that learned the public key — and the allow list is the same one the
  // Play path already trusts.
  if (!config.allowedPackageNames.includes(parsed.packageName)) {
    console.warn(`provision-licence: refused package ${parsed.packageName || "(empty)"}`);
    return jsonResponse(denied(DENIAL.NOT_VERIFIED, "This app is not allowed to redeem organisational licences."));
  }

  const verification = await verifyLicence({
    token: parsed.licence,
    publicKeyPem: async (kid: string) => {
      const fromEnv = readLicencePublicKey(env, kid);
      if (fromEnv !== "") return fromEnv;
      if (kid !== "" && env.PRO_KV) {
        const fromKv = await env.PRO_KV.get(`licence-key:${kid}`);
        if (fromKv) return fromKv;
      }
      return null;
    },
    now,
  });
  if (!verification.ok) {
    console.warn(`provision-licence: denied (${verification.reason})`);
    return jsonResponse(denied(verification.reason, verification.message));
  }
  const claims = verification.claims;

  // The operator ended the agreement. Checked before anything else, because a tombstoned licence
  // must refuse both the devices that already hold keys and any device that tries to redeem now.
  const revoked = await env.PRO_KV.get(licenceRevokedKey(claims.lic));
  if (revoked !== null) {
    console.warn(`provision-licence: refused — ${claims.lic} was revoked`);
    return jsonResponse(
      denied(DENIAL.REVOKED, "This organisation's licence has been revoked. Contact whoever issued it."),
    );
  }

  // Seats are the licence's own device limit when it states one, and the deployment's default
  // otherwise, so an operator can sell either "5 seats" or "whatever this server allows". Three
  // cases, because the licence's own vocabulary has three: an unlimited licence is stored as `0`,
  // which means no cap everywhere that reads it.
  const seatLimit =
    claims.seats === UNLIMITED_SEATS ? 0 : claims.seats > 0 ? claims.seats : config.deviceLimit;

  // One index entry per **device**, not per licence. Every device on a licence gets its own key
  // record and its own secret, so a reinstall rotates only that device's credential — indexing by
  // licence alone meant each provisioning revoked the shared key and left the previous device
  // locked out, which is the opposite of what "unlimited users" is sold as.
  const indexKey = licenceIndexKey(claims.lic, parsed.deviceId);
  const indexedKeyId = await env.PRO_KV.get(indexKey);
  const existingKey = indexedKeyId === null ? null : await getKeyRecord(env.PRO_KV, indexedKeyId);

  // A revoked *device* is terminal for that device, not for the licence: otherwise revoking a
  // leaked credential would achieve nothing, since the holder would simply redeem again. Nothing in
  // the app calls revoke, so a customer reinstalling cannot trip this.
  if (existingKey !== null && existingKey.status === STATUS.REVOKED) {
    console.warn(`provision-licence: refused — device ${shortId(existingKey.keyId)} was revoked`);
    return jsonResponse(
      denied(DENIAL.REVOKED, "This device's access was revoked. Contact whoever issued the licence."),
    );
  }

  // Seat identity policy (Free → Pro continuity):
  //  * Reinstall of the same persistent `deviceId` hits `existingKey !== null` below and updates
  //    the existing `LicenceMeter` seat row (`device_id PRIMARY KEY`) in place — consuming 0 new seats.
  //  * A genuinely new `deviceId` enters the `else` branch and consumes 1 seat (up to `seatLimit`).
  //  * Pre-existing orphaned seats from installs that rotated `deviceId` before backup-persisted
  //    device ids are NOT blindly pruned (which could evict a legitimate 2nd device); they age out
  //    automatically via `LicenceMeter`'s 14-day idle eviction (`IDLE_DEVICE_EVICTION_MS`) or
  //    explicit `releaseDevice`.
  //  * If this `deviceId` previously held an active Free credential, retire it so the install is
  //    never counted twice (once as Free and again as a Pro seat).
  const freeUpgrade = await retireFreeDeviceOnProUpgrade(env, parsed.deviceId, now);

  let record: KeyRecord;
  let virtualKey: string;
  const businessCapMicroUsd = (config.monthlyCapMicroUsd ?? DEFAULT_SOFT_CAP_MICRO_USD) * 10;

  if (existingKey !== null) {
    // This device already holds a key for this licence — a reinstall, or data cleared. Rotate its
    // secret: the old one was never presented to the server again, so leaving it live would let a
    // copied credential keep working. Only *this* record is touched, which is what leaves every
    // other device on the licence working.
    virtualKey = mintVirtualKey();
    const supersededKeyId = existingKey.keyId;
    const newKeyId = await sha256Hex(virtualKey);
    record = {
      ...existingKey,
      keyId: newKeyId,
      licenceId: claims.lic,
      deviceId: parsed.deviceId,
      ...(freeUpgrade.freeMeterId ? { upgradedFromFreeMeterId: freeUpgrade.freeMeterId } : {}),
      quotaUnit: QUOTA_UNIT_PPM,
      monthlyCapMicroUsd: businessCapMicroUsd,
      updatedAt: now,
    };
    await putKeyRecord(env.PRO_KV, record);
    await rememberActiveKey(env.PRO_KV, newKeyId);
    await env.PRO_KV.put(indexKey, newKeyId);
    await markSupersededKeyDead(env, supersededKeyId, newKeyId, now);
    if (env.LICENCE_METER) {
      await callLicenceMeter(env.LICENCE_METER, claims.lic, "upsertDevice", {
        licenceId: claims.lic,
        deviceId: parsed.deviceId,
        keyId: newKeyId,
        status: STATUS.ACTIVE,
        plan: PRODUCT_ID_BUSINESS,
        periodEnd: claims.exp,
        notAfter: claims.exp,
        monthlyCapMicroUsd: businessCapMicroUsd,
        deviceLimit: seatLimit,
        now,
      });
    }
  } else {
    // A device joining the licence. The seat count is the number of device records it already has,
    // which is the whole licence's usage rather than one record's `devices` array. An exempt device
    // joins without consuming a seat: it is the operator's own hardware, and the seat cap exists to
    // bound customers, not to lock the owner out of their own licence.
    const seated = await countLicenceDevices(env, claims.lic);
    const exemptDevice =
      (await isExemptIp(env, request.headers.get("cf-connecting-ip") ?? "")) ||
      (await isExemptDevice(env, parsed.deviceId));
    if (!exemptDevice && seatLimit > 0 && seated >= seatLimit) {
      console.warn(`provision-licence: seat limit reached for ${claims.lic} (limit ${seatLimit})`);
      return jsonResponse(
        denied(
          DENIAL.DEVICE_LIMIT,
          `This licence is already active on ${seatLimit} devices. Ask whoever issued it for more seats.`,
        ),
      );
    }
    virtualKey = mintVirtualKey();
    const keyId = await sha256Hex(virtualKey);
    record = {
      ...newKeyRecord({
        keyId,
        // Recorded as the app that redeemed it, so an operator reading the key record can tell a
        // business licence from a subscription at a glance.
        packageName: parsed.packageName,
        productId: PRODUCT_ID_BUSINESS,
        // The licence id stands in for the account binding Play supplies as an obfuscated id, and is
        // what lets a sweep find every device of one licence.
        obfuscatedAccountId: claims.lic,
        // `0` means the licence never expires; `isGrantActive` reads it that way, so a perpetual
        // licence needs no far-future sentinel.
        expiresAt: claims.exp,
        status: STATUS.ACTIVE,
        playState: "",
        latestOrderId: "",
        deviceId: parsed.deviceId,
        deviceLimit: seatLimit,
        now,
      }),
      licenceId: claims.lic,
      deviceId: parsed.deviceId,
      ...(freeUpgrade.freeMeterId ? { upgradedFromFreeMeterId: freeUpgrade.freeMeterId } : {}),
      quotaUnit: QUOTA_UNIT_PPM,
      monthlyCapMicroUsd: businessCapMicroUsd,
    };
    await putKeyRecord(env.PRO_KV, record);
    await rememberActiveKey(env.PRO_KV, keyId);
    // Indexed last, so a failure above cannot leave the licence looking as though this device had
    // joined and consuming a seat that was never issued a key.
    await env.PRO_KV.put(indexKey, keyId);
    if (env.LICENCE_METER) {
      await callLicenceMeter(env.LICENCE_METER, claims.lic, "upsertDevice", {
        licenceId: claims.lic,
        deviceId: parsed.deviceId,
        keyId,
        status: STATUS.ACTIVE,
        plan: PRODUCT_ID_BUSINESS,
        periodEnd: claims.exp,
        notAfter: claims.exp,
        monthlyCapMicroUsd: businessCapMicroUsd,
        deviceLimit: seatLimit,
        now,
      });
    }
    if (!exemptDevice) {
      await recordFunnelEventOnce(env, "pro_activated", claims.lic, now);
    }
  }

  console.log(
    `provision-licence: granted ${shortId(record.keyId)} for ${claims.lic}` +
      `${claims.ref === "" ? "" : ` (invoice ${claims.ref})`}`,
  );

  return jsonResponse({
    ok: true,
    virtualKey,
    proxyBaseUrl: config.proxyBaseUrl,
    expiresAt: claims.exp,
    reason: "",
    message: "",
  } satisfies ProvisionResponse);
}

/**
 * How many devices a licence currently has.
 *
 * Counted from the licence's own index entries rather than from a stored counter: those entries are
 * the truth, and a counter that drifted from them would either refuse a seat the customer paid for
 * or grant one that was never sold.
 *
 * The prefix is applied here rather than handed to `list`, because the KV stub the tests use
 * ignores listing options — and because a real listing is paginated, so the filter has to be right
 * whatever the binding returns.
 */
export async function countLicenceDevices(env: Env, licenceId: string): Promise<number> {
  const prefix = licenceDevicePrefix(licenceId);
  let count = 0;
  let cursor: string | undefined = undefined;
  let complete = false;

  while (!complete) {
    const listed: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
      await env.PRO_KV.list({ prefix, cursor });
    count += listed.keys.filter((key: { name: string }) => key.name.startsWith(prefix)).length;
    complete = listed.list_complete;
    cursor = listed.cursor;
    if (!cursor) break;
  }
  return count;
}

/**
 * Ends a licence outright: tombstones it, then revokes every key it issued.
 *
 * Both halves are needed. The tombstone is what stops a device redeeming *after* the fact; the
 * sweep is what stops the devices already holding keys. Either alone leaves the customer working —
 * a tombstone alone until their credentials are rotated away, a sweep alone immediately, by simply
 * redeeming again.
 *
 * Called by `/api/revoke-key` when the key belongs to a business licence. For a company credential
 * the operator's unit of revocation is the agreement, not one laptop — a fifty-seat licence would
 * otherwise take fifty revocations to end.
 */
export async function revokeLicence(env: Env, licenceId: string, now: number): Promise<number> {
  await env.PRO_KV.put(licenceRevokedKey(licenceId), String(now));
  if (env.LICENCE_METER) {
    await callLicenceMeter(env.LICENCE_METER, licenceId, "setLicenceState", {
      licenceId,
      status: STATUS.REVOKED,
      periodEnd: 0,
      notAfter: 0,
      now,
    });
  }
  const prefix = licenceDevicePrefix(licenceId);
  let revoked = 0;
  let cursor: string | undefined = undefined;
  let complete = false;

  while (!complete) {
    const listed: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
      await env.PRO_KV.list({ prefix, cursor });
    for (const entry of listed.keys) {
      if (!entry.name.startsWith(prefix)) continue;
      const keyId = await env.PRO_KV.get(entry.name);
      if (keyId === null) continue;
      await revokeKey(env.PRO_KV, keyId, STATUS.REVOKED, now);
      revoked += 1;
    }
    complete = listed.list_complete;
    cursor = listed.cursor;
    if (!cursor) break;
  }
  console.log(`provision-licence: revoked ${licenceId} — ${revoked} device key(s) retired`);
  return revoked;
}
