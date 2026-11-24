/**
 * `POST /api/provision-key` — the only path that mints a virtual key.
 *
 * The order of operations is the security design, and it does not bend:
 *
 *  1. the service account must be configured, or the request is refused (`not_verified`) —
 *     the client's claim about a receipt is never evidence;
 *  2. the package name must be in the allow list and the product id must be the configured one;
 *  3. every purchase token is verified against the **Play Developer API**, server-side;
 *  4. only then is a key minted, and only for a grant Play reports as live.
 *
 * Two properties make the result usable rather than merely correct:
 *
 *  * **reinstall returns the same key.** A purchase token maps to a key hash, so a wipe and
 *    reinstall gets its key back instead of minting an unbounded number of them. When Play reports
 *    a `linkedPurchaseToken` (upgrade, downgrade, re-signup), that token is linked to the same
 *    key too, so a plan change does not strand the user on a new credential.
 *  * **re-provisioning the same device costs nothing.** Devices are a set with a cap, not a
 *    counter, so a third device is refused while the first two keep working forever.
 */

import { mintVirtualKey, sha256Hex } from "./base64";
import type { Env, ProxyConfig } from "./config";
import {
  DENIAL,
  MAX_PURCHASE_TOKENS,
  PRODUCT_ID_PRO,
  STATUS,
  VIRTUAL_KEY_PREFIX,
  VIRTUAL_KEY_PREFIX_LEGACY,
} from "./constants";
import { acknowledgeSubscription, describeError, shortHash, verifySubscriptionPurchase } from "./google";
import { DEFAULT_SOFT_CAP_MICRO_USD } from "./cost";
import { retireFreeDeviceOnProUpgrade } from "./free";
import { recordFunnelEventOnce } from "./funnel";
import { callLicenceMeter, hasLiveLicenceMeter } from "./licence-meter";
import type { PlayGrant } from "./play";
import { grantFromPurchase, hasLineItemForProduct } from "./play";
import { isGrantActive } from "./quota";
import { badRequest, jsonResponse } from "./responses";
import {
  bindDevice,
  findKeyByVirtualKey,
  getKeyRecord,
  getPurchaseRecord,
  linkPurchaseTokenHash,
  newKeyRecord,
  purchaseTokenHash,
  putKeyRecord,
  putPurchaseRecord,
  rememberActiveKey,
  shortId,
} from "./store";
import type { KeyRecord, PurchaseRecord } from "./store";

/** The client's request body, exactly as `ProProvisionRequest` serialises it. */
export interface ProvisionRequest {
  productId: string;
  packageName: string;
  purchaseTokens: string[];
  deviceId: string;
  obfuscatedAccountId: string;
  appVersion: string;
}

/** The client's expected answer, exactly as `ProProvisionResponse` deserialises it. */
export interface ProvisionResponse {
  ok: boolean;
  virtualKey: string;
  proxyBaseUrl: string;
  expiresAt: number;
  reason: string;
  message: string;
}

/**
 * Builds a refusal in the client's response shape.
 *
 * Exported so `licence-provision.ts` answers with the identical shape: a business licence and a
 * Play subscription are two routes to one managed key, and the app parses one response type.
 */
export function denied(reason: string, message: string): ProvisionResponse {
  return { ok: false, virtualKey: "", proxyBaseUrl: "", expiresAt: 0, reason, message };
}

/**
 * Parses the body without trusting any field's type.
 *
 * A hostile client can send anything; a `TypeError` from `purchaseTokens.map` deep inside the
 * handler would surface as a 500 and, worse, look like a server bug rather than a bad request.
 */
export function parseProvisionRequest(raw: unknown): ProvisionRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("body must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const tokensRaw = record["purchaseTokens"];
  if (!Array.isArray(tokensRaw)) throw badRequest("purchaseTokens must be an array of strings");
  const purchaseTokens = tokensRaw
    .filter((token): token is string => typeof token === "string" && token.trim() !== "")
    .map((token) => token.trim())
    .slice(0, MAX_PURCHASE_TOKENS);
  return {
    productId: typeof record["productId"] === "string" ? record["productId"] : "",
    packageName: typeof record["packageName"] === "string" ? record["packageName"] : "",
    purchaseTokens,
    deviceId: typeof record["deviceId"] === "string" ? record["deviceId"].trim() : "",
    obfuscatedAccountId:
      typeof record["obfuscatedAccountId"] === "string" ? record["obfuscatedAccountId"].trim() : "",
    appVersion: typeof record["appVersion"] === "string" ? record["appVersion"] : "",
  };
}

/**
 * Supported Play subscription product IDs.
 *
 * Exactly one product exists (`gestu_pro_monthly`, with monthly and yearly base plans inside it),
 * plus whatever `GESTU_PRODUCT_ID` the deployment configures. A leftover three-tier product id is
 * *not* accepted: the Worker and the store must agree on one product or the Worker would be metering
 * a plan it does not know.
 */
export function supportedPlayProductIds(config: ProxyConfig): string[] {
  const ids = new Set<string>([PRODUCT_ID_PRO]);
  if (config.productId.trim() !== "") ids.add(config.productId.trim());
  return [...ids];
}

/** True for any supported product; kept as a rank helper for choosing the "best" verified grant. */
function tierRankForProduct(productId: string): number {
  return productId === PRODUCT_ID_PRO ? 1 : 0;
}

/** A verified token plus everything the caller needs to record it. */
interface TokenVerification {
  token: string;
  tokenHash: string;
  grant: PlayGrant;
  acknowledgementState: string;
}

type ProvisionOutcome =
  | { kind: "granted"; verifications: TokenVerification[]; best: TokenVerification }
  | { kind: "denied"; reason: string; message: string; transient: boolean };

/**
 * Verifies every candidate token and decides what the batch as a whole means.
 *
 * A subscription legitimately carries several tokens (upgrades and re-signups supersede earlier
 * ones), so a single dead token is not a refusal — the live one wins. `best` is the most entitled
 * grant: live first, then furthest expiry. Only when *no* token yields a live grant is the batch
 * refused, and then with the strongest reason the batch produced.
 */
async function verifyAllTokens(input: {
  env: Env;
  config: ProxyConfig;
  request: ProvisionRequest;
  now: number;
}): Promise<ProvisionOutcome> {
  const { env, config, request, now } = input;
  const verifications: TokenVerification[] = [];
  let transient = false;
  let sawNotFound = false;
  let bestNonLive: TokenVerification | null = null;

  for (const token of request.purchaseTokens) {
    const tokenHash = await purchaseTokenHash(token);
    const result = await verifySubscriptionPurchase({
      env,
      config,
      packageName: request.packageName,
      token,
      tokenHash,
      now,
    });
    if (!result.ok) {
      if (result.failure.kind === "transient") transient = true;
      if (result.failure.kind === "not_found") sawNotFound = true;
      if (result.failure.kind === "config") {
        // Configuration failures are not the user's problem and are not retryable by them: the
        // server cannot verify anything until an operator fixes it.
        console.error(`provision: verification unavailable (${shortHash(tokenHash)})`);
      }
      continue;
    }
    const lineItems = result.purchase.lineItems ?? [];
    const supportedProducts = supportedPlayProductIds(config);
    if (!supportedProducts.some((productId) => hasLineItemForProduct(lineItems, productId))) {
      // A receipt for a different product of the same package: refuse it here rather than mint a
      // key from someone else's entitlement.
      console.warn(
        `provision: token ${shortHash(tokenHash)} is not for a supported product (${supportedProducts.join(", ")})`,
      );
      continue;
    }
    const grant = grantFromPurchase(result.purchase, now);
    const verification: TokenVerification = {
      token,
      tokenHash,
      grant,
      acknowledgementState: grant.acknowledgementState,
    };
    verifications.push(verification);
    if (isGrantActive(grant.status, grant.expiresAt, now) || grant.entitled) {
      if (bestNonLive === null || grant.expiresAt > bestNonLive.grant.expiresAt) bestNonLive = verification;
    }
  }

  const live = verifications
    .filter((item) => item.grant.entitled || isGrantActive(item.grant.status, item.grant.expiresAt, now))
    .sort(
      (a, b) =>
        b.grant.expiresAt - a.grant.expiresAt ||
        tierRankForProduct(b.grant.productId) - tierRankForProduct(a.grant.productId),
    );
  const best = live[0];
  if (best !== undefined) return { kind: "granted", verifications, best };

  if (transient) {
    // A Play outage must not be answered with a permanent "denied": the app treats a 200 with
    // `ok:false` as final and would stop asking. 503 makes it retry on the next foreground.
    return {
      kind: "denied",
      reason: DENIAL.NOT_VERIFIED,
      message: "Play verification is temporarily unavailable; retry shortly.",
      transient: true,
    };
  }
  if (verifications.some((item) => item.grant.status === STATUS.REVOKED)) {
    return {
      kind: "denied",
      reason: DENIAL.REVOKED,
      message: "This subscription was revoked by Google Play.",
      transient: false,
    };
  }
  if (verifications.length > 0) {
    const status = verifications[0]?.grant.status ?? STATUS.NONE;
    if (status === STATUS.EXPIRED) {
      return {
        kind: "denied",
        reason: DENIAL.EXPIRED,
        message: "This subscription has expired. Resubscribe to continue.",
        transient: false,
      };
    }
    if (status === STATUS.ON_HOLD) {
      // On hold is a payment problem the user can fix in Play; `expired` is the client's
      // "subscription is over" state, which is the honest description of access having stopped.
      return {
        kind: "denied",
        reason: DENIAL.EXPIRED,
        message: "Google Play could not take the payment and the subscription is on hold. Update your payment method in Play.",
        transient: false,
      };
    }
    return {
      kind: "denied",
      reason: DENIAL.NOT_VERIFIED,
      message: "This purchase is not active yet. If you were just charged, try again in a moment.",
      transient: false,
    };
  }
  if (sawNotFound) {
    // Play does not know any of the supplied tokens: a fabricated or foreign receipt.
    return {
      kind: "denied",
      reason: DENIAL.INVALID_TOKEN,
      message: "Google Play does not recognise this purchase for this app.",
      transient: false,
    };
  }
  return {
    kind: "denied",
    reason: DENIAL.NOT_VERIFIED,
    message: "No usable purchase was supplied.",
    transient: false,
  };
}

/**
 * Chooses the key a batch of tokens should resolve to.
 *
 * Returns the key record when at least one token already points at a live key (the reinstall and
 * upgrade cases), or `null` when this is a genuinely new subscription.
 *
 * Two tokens pointing at *different* keys happen when a user upgrades and the Client obtains the
 * rotated key before the old one expires. KV cannot merge the two key *secrets* (only their
 * hashes are stored), so the record with the later expiry wins and every token is re-pointed at
 * it; the losing key keeps working for its remaining quota records but will stop resolving, and
 * the app re-provisions its way onto the winner on the next foreground. Per-key quota history is
 * deliberately *not* transferred — a plan change must not grant a second month's allowance, and
 * must not silently delete one either.
 */
async function resolveExistingKey(
  env: Env,
  verifications: readonly TokenVerification[],
  now: number,
): Promise<KeyRecord | null> {
  const records: Array<{ record: KeyRecord; tokenHash: string }> = [];
  for (const verification of verifications) {
    const purchase = await getPurchaseRecord(env.PRO_KV, verification.tokenHash);
    if (purchase === null) continue;
    const record = await getKeyRecord(env.PRO_KV, purchase.keyId);
    if (record === null || record.status === STATUS.REVOKED) continue;
    records.push({ record, tokenHash: verification.tokenHash });
  }
  if (records.length === 0) return null;
  records.sort((a, b) => b.record.expiresAt - a.record.expiresAt || b.record.updatedAt - a.record.updatedAt);
  const winner = records[0];
  if (winner === undefined) return null;
  const merged: KeyRecord = { ...winner.record, expiresAt: Math.max(winner.record.expiresAt, now) };
  for (const entry of records) {
    if (entry.record.keyId === merged.keyId) continue;
    console.warn(
      `provision: linking ${shortId(entry.record.keyId)} purchases onto ${shortId(merged.keyId)} after a plan change`,
    );
  }
  return merged;
}

/** Reads the presented virtual key from either accepted place. */
export function presentedKey(request: Request): string {
  const subscriptionHeader = request.headers.get("X-Gestu-Subscription");
  if (subscriptionHeader !== null && subscriptionHeader.trim() !== "") return subscriptionHeader.trim();
  const authorization = request.headers.get("authorization");
  if (authorization === null) return "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? "";
}

/** True when `value` is a key this Worker could have minted. */
export function isWellFormedVirtualKey(value: string): boolean {
  return (value.startsWith(VIRTUAL_KEY_PREFIX) || value.startsWith(VIRTUAL_KEY_PREFIX_LEGACY)) && value.length >= 20 && value.length <= 128;
}

/**
 * Handles the provision request.
 *
 * Returns a `Response` for every outcome, including refusals, because the client distinguishes
 * "denied" (a 200 with `ok:false`) from "failed" (a non-2xx) and has different recovery for each.
 */
export async function handleProvisionKey(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now = Date.now(),
): Promise<Response> {
  let parsed: ProvisionRequest;
  try {
    parsed = parseProvisionRequest(await request.json());
  } catch (error) {
    if (error instanceof Error && error.name === "HttpError") throw error;
    throw badRequest("body must be JSON");
  }

  if (parsed.deviceId === "") throw badRequest("deviceId is required");
  if (parsed.purchaseTokens.length === 0) {
    return jsonResponse(denied(DENIAL.NOT_VERIFIED, "No purchase tokens were supplied."));
  }
  if (!config.allowedPackageNames.includes(parsed.packageName)) {
    console.warn(`provision: refused package ${parsed.packageName || "(empty)"}`);
    return jsonResponse(denied(DENIAL.NOT_VERIFIED, "This app is not allowed to provision managed keys."));
  }
  const supportedProducts = supportedPlayProductIds(config);
  if (!supportedProducts.includes(parsed.productId)) {
    // The app and the Worker must agree on the product id; a mismatch means one of them was
    // deployed without the other, and minting anyway would sell a plan the Worker cannot meter.
    console.error(
      `provision: product id mismatch — client sent ${parsed.productId || "(empty)"}, supported ${supportedProducts.join(", ")}`,
    );
    return jsonResponse(denied(DENIAL.NOT_VERIFIED, "This subscription product is not supported by this server."));
  }

  const outcome = await verifyAllTokens({ env, config, request: parsed, now });
  if (outcome.kind === "denied") {
    const status = outcome.transient ? 503 : 200;
    console.warn(`provision: denied (${outcome.reason}${outcome.transient ? ", transient" : ""})`);
    return jsonResponse(
      denied(outcome.reason, outcome.message),
      { status },
    );
  }

  const { best, verifications } = outcome;
  const verifiedProductId =
    best.grant.productId && supportedProducts.includes(best.grant.productId)
      ? best.grant.productId
      : parsed.productId;

  // The account binding: Play can report an obfuscated account id, and when it does, a token
  // presented under a different account is a shared or resold receipt.
  if (best.grant.obfuscatedExternalAccountId !== "") {
    if (
      parsed.obfuscatedAccountId !== "" &&
      parsed.obfuscatedAccountId !== best.grant.obfuscatedExternalAccountId
    ) {
      console.warn("provision: obfuscated account id does not match the purchase");
      return jsonResponse(
        denied(DENIAL.INVALID_TOKEN, "This purchase belongs to a different account."),
      );
    }
  }

  const existing = await resolveExistingKey(env, verifications, now);
  let record: KeyRecord;
  let virtualKey: string;

  if (existing !== null) {
    record = existing;
    const binding = await bindDevice({
      kv: env.PRO_KV,
      record,
      deviceId: parsed.deviceId,
      deviceLimit: config.deviceLimit,
      now,
    });
    if (binding.kind === "limit_reached") {
      console.warn(`provision: device limit reached for ${shortId(record.keyId)} (limit ${binding.limit})`);
      return jsonResponse(
        denied(
          DENIAL.DEVICE_LIMIT,
          `This subscription is already active on ${binding.limit} devices. Remove one in Google Play, or use your own API key.`,
        ),
      );
    }
    record = binding.record;
    // The key cannot be recovered from its hash, so a re-provision mints a *new* secret and the
    // purchase index is moved onto the new hash. The superseded record is revoked rather than left
    // live: the old secret was never shown to the server again, and leaving it valid would mean a
    // leaked or backed-up key keeps working indefinitely. Revocation is what makes "reinstall
    // returns the same key" mean the same *subscription*, not the same secret.
    virtualKey = mintVirtualKey();
    const supersededKeyId = record.keyId;
    const newKeyId = await sha256Hex(virtualKey);
    record = {
      ...record,
      keyId: newKeyId,
      productId: verifiedProductId,
      // Preserve all bound devices returned by `bindDevice` (same-device reinstall updates
      // `lastSeenAt` in place without consuming a new seat; other bound devices stay intact).
      devices: record.devices,
      updatedAt: now,
    };
    await putKeyRecord(env.PRO_KV, record);
    await rememberActiveKey(env.PRO_KV, newKeyId);
    await markSupersededKeyDead(env, supersededKeyId, newKeyId, now);
  } else {
    virtualKey = mintVirtualKey();
    const keyId = await sha256Hex(virtualKey);
    record = newKeyRecord({
      keyId,
      packageName: parsed.packageName,
      productId: verifiedProductId,
      obfuscatedAccountId: best.grant.obfuscatedExternalAccountId || parsed.obfuscatedAccountId,
      expiresAt: best.grant.expiresAt,
      status: best.grant.status,
      playState: best.grant.playState,
      latestOrderId: "",
      deviceId: parsed.deviceId,
      // A Play subscription always takes the deployment's cap; it has no per-licence seat count.
      deviceLimit: config.deviceLimit,
      now,
    });
    await putKeyRecord(env.PRO_KV, record);
    await rememberActiveKey(env.PRO_KV, keyId);
  }

  // Point every verified token — and the token it replaced — at the key that was just settled on.
  for (const verification of verifications) {
    const linkedHash = verification.grant.linkedPurchaseToken
      ? await purchaseTokenHash(verification.grant.linkedPurchaseToken)
      : "";
    const itemProductId = verification.grant.productId || verifiedProductId;
    const purchase: PurchaseRecord = {
      tokenHash: verification.tokenHash,
      keyId: record.keyId,
      packageName: parsed.packageName,
      productId: itemProductId,
      obfuscatedAccountId: verification.grant.obfuscatedExternalAccountId,
      status: verification.grant.status,
      expiresAt: verification.grant.expiresAt,
      updatedAt: now,
      linkedTokenHash: linkedHash,
    };
    await putPurchaseRecord(env.PRO_KV, purchase);
    record = linkPurchaseTokenHash(record, verification.tokenHash);
    if (linkedHash !== "") {
      const previous = await getPurchaseRecord(env.PRO_KV, linkedHash);
      record = linkPurchaseTokenHash(record, linkedHash);
      if (previous !== null && previous.keyId === record.keyId) continue;
      if (previous !== null) {
        // The superseded purchase pointed at another key: re-point it so the old token also
        // resolves here (same subscription, same key), which is what stops an upgrade from
        // producing two independent credentials.
        await putPurchaseRecord(env.PRO_KV, { ...previous, keyId: record.keyId, updatedAt: now });
      } else {
        // The superseded token was never provisioned through this Worker; record it so a later
        // request carrying it resolves to the same key instead of minting a new one.
        await putPurchaseRecord(env.PRO_KV, {
          tokenHash: linkedHash,
          keyId: record.keyId,
          packageName: parsed.packageName,
          productId: itemProductId,
          obfuscatedAccountId: verification.grant.obfuscatedExternalAccountId,
          status: verification.grant.status,
          expiresAt: verification.grant.expiresAt,
          updatedAt: now,
          linkedTokenHash: "",
        });
      }
    }
  }

  const playLicenceId = record.licenceId || `play:${best.tokenHash}`;
  const monthlyCapMicroUsd = config.monthlyCapMicroUsd ?? DEFAULT_SOFT_CAP_MICRO_USD;
  const liveDo = hasLiveLicenceMeter(env);
  // Link Free -> Pro on the same persistent deviceId: retire any live Free credential/seat so the
  // upgraded install is not counted twice (once as Free and again as a Pro seat).
  const freeUpgrade = await retireFreeDeviceOnProUpgrade(env, parsed.deviceId, now);

  record = {
    ...record,
    productId: verifiedProductId,
    status: best.grant.status,
    expiresAt: best.grant.expiresAt,
    playState: best.grant.playState,
    obfuscatedAccountId: record.obfuscatedAccountId || best.grant.obfuscatedExternalAccountId,
    ...(liveDo ? { licenceId: playLicenceId, monthlyCapMicroUsd } : {}),
    ...(freeUpgrade.freeMeterId ? { upgradedFromFreeMeterId: freeUpgrade.freeMeterId } : {}),
    updatedAt: now,
  };
  if (liveDo) {
    await callLicenceMeter(env.LICENCE_METER, playLicenceId, "upsertDevice", {
      licenceId: playLicenceId,
      deviceId: parsed.deviceId,
      keyId: record.keyId,
      status: record.status,
      plan: verifiedProductId,
      periodEnd: record.expiresAt,
      notAfter: record.expiresAt,
      monthlyCapMicroUsd,
      deviceLimit: config.deviceLimit,
      now,
    });
  }
  await putKeyRecord(env.PRO_KV, record);

  // PII-free funnel counter: recorded once per subscription so reinstalls or 2nd devices do not double-count.
  await recordFunnelEventOnce(env, "pro_activated", playLicenceId, now);

  // Acknowledging is best-effort by design: Google refunds unacknowledged purchases after three
  // days, so it matters, but a failure must never cost a paying user their key.
  const acknowledgement = await acknowledgeBest({
    env,
    config,
    packageName: parsed.packageName,
    productId: verifiedProductId,
    verification: best,
    now,
  });
  if (!acknowledgement.ok) {
    console.warn(`provision: acknowledgement pending for ${shortHash(best.tokenHash)}: ${acknowledgement.detail}`);
  }

  return jsonResponse({
    ok: true,
    virtualKey,
    proxyBaseUrl: config.proxyBaseUrl,
    expiresAt: best.grant.expiresAt,
    reason: "",
    message: acknowledgement.ok ? "" : "Purchase verified; acknowledgement with Google Play is pending.",
  } satisfies ProvisionResponse);
}

/**
 * Kills the key record a re-provision just replaced.
 *
 * The record is rewritten in place rather than deleted so the slot still explains itself, and a
 * revoked record is refused by `findKeyByVirtualKey`, so the old secret stops authenticating
 * immediately. The purchase index is left alone — it already points at the new key.
 */
export async function markSupersededKeyDead(
  env: Env,
  supersededKeyId: string,
  newKeyId: string,
  now: number,
): Promise<void> {
  if (supersededKeyId === newKeyId) return;
  const superseded = await getKeyRecord(env.PRO_KV, supersededKeyId);
  if (superseded === null) return;
  const tombstone: KeyRecord = {
    ...superseded,
    status: STATUS.REVOKED,
    revokedAt: now,
    updatedAt: now,
    purchaseTokenHashes: [],
    devices: [],
  };
  await putKeyRecord(env.PRO_KV, tombstone);
  console.log(`provision: superseded key ${shortId(supersededKeyId)} revoked in favour of ${shortId(newKeyId)}`);
}

async function acknowledgeBest(input: {
  env: Env;
  config: ProxyConfig;
  packageName: string;
  productId: string;
  verification: TokenVerification;
  now: number;
}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const result = await acknowledgeSubscription({
    env: input.env,
    config: input.config,
    packageName: input.packageName,
    productId: input.verification.grant.productId || input.productId,
    token: input.verification.token,
    tokenHash: input.verification.tokenHash,
    acknowledgementState: input.verification.acknowledgementState,
    now: input.now,
  });
  return result.ok ? { ok: true } : { ok: false, detail: result.detail };
}

/** Exposed for the revoke and status handlers, which resolve a key without verifying a purchase. */
export { findKeyByVirtualKey, describeError };
