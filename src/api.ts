/**
 * The account-facing endpoints: revoke, status, and Google's Real-time Developer Notifications.
 *
 * All three share one rule: **the purchase token is the only key into the data model, and the
 * virtual key is the only key into a subscription.** Nothing here trusts a client-supplied
 * subscription state, and nothing here logs a credential.
 */

import { base64UrlDecode, sha256Hex } from "./base64";
import type { Env, ProxyConfig } from "./config";
import { PLAN_FREE, PLAN_PRO, PRODUCT_ID_BUSINESS, PRODUCT_ID_FREE, STATUS, tierForProductId } from "./constants";
import type { SubscriptionStatusId } from "./constants";
import { revokeLicence } from "./licence-provision";
import {
  describeError,
  shortHash,
  verifyPubSubOidcToken,
  verifySubscriptionPurchase,
} from "./google";
import type { DecodedRtdn, RtdnPayload } from "./play";
import { classifyRtdn, grantFromPurchase, hasLineItemForProduct, terminalStateFromNotification } from "./play";
import {
  isGrantActive,
  monthlyInputTokenLimitFor,
  monthlyOutputTokenLimitFor,
  readTierUsage,
  tokenLimitFor,
} from "./quota";
import type { QuotaSnapshot } from "./quota";
import { badRequest, jsonResponse } from "./responses";
import { presentedKey } from "./provision";
import { callLicenceMeter, hasLiveLicenceMeter } from "./licence-meter";
import type { LicenceUsageSummary } from "./licence-meter";
import {
  bindDevice,
  deviceLimitFor,
  findKeyByVirtualKey,
  getKeyRecord,
  getPurchaseRecord,
  purchaseTokenHash,
  readQuota,
  revokeKey,
  shortId,
  updateKeyStatus,
} from "./store";
import type { KeyRecord } from "./store";

/** `POST /api/revoke-key` — the client sends the virtual key in `X-Gestu-Subscription`. */
export interface RevokeResponse {
  ok: true;
}

/**
 * Revokes the presented key.
 *
 * Always answers `{ok:true}`, including for an unknown key. The client treats this as best-effort
 * (`HttpProKeyProvisioner.revoke` ignores the answer entirely) and the *real* enforcement is the
 * server-side expiry plus Play's own RTDN; telling a caller "that key was not valid" would only
 * help someone probing for valid keys.
 */
export async function handleRevokeKey(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const virtualKey = presentedKey(request);
  if (virtualKey === "") return jsonResponse({ ok: true } satisfies RevokeResponse);
  const record = await findKeyByVirtualKey(env.PRO_KV, virtualKey);
  if (record === null) return jsonResponse({ ok: true } satisfies RevokeResponse);

  // A business licence is one agreement shared by a whole company, so revoking any of its device
  // keys ends the licence rather than one laptop. Without this an operator would have to revoke a
  // fifty-seat licence fifty times, using credentials they would have to have collected first —
  // which in practice means a customer who stopped paying keeps working.
  if (record.productId === PRODUCT_ID_BUSINESS && record.obfuscatedAccountId !== "") {
    await revokeLicence(env, record.obfuscatedAccountId, now);
    return jsonResponse({ ok: true } satisfies RevokeResponse);
  }

  await revokeKey(env.PRO_KV, record.keyId, STATUS.REVOKED, now);
  console.log(`revoke: key ${shortId(record.keyId)} revoked at the client's request`);
  return jsonResponse({ ok: true } satisfies RevokeResponse);
}

/** The client's `ProStatusRequest`. */
export interface StatusRequest {
  virtualKey: string;
  deviceId: string;
}

/** The client's `ProStatusResponse`. */
export interface StatusResponse {
  ok: boolean;
  plan: string;
  status: string;
  periodId: string;
  usedTokens: number;
  limitTokens: number;
  renewsAt: number;
  expiresAt: number;
  message: string;
  quotaUnit?: "ppm" | "tokens";
  quotaMode?: "normal" | "reduced";
  inputTokensUsed?: number;
  inputTokensLimit?: number;
  outputTokensUsed?: number;
  outputTokensLimit?: number;
}

function statusResponse(partial: Partial<StatusResponse>): StatusResponse {
  return {
    ok: false,
    plan: PLAN_FREE,
    status: STATUS.NONE,
    periodId: "",
    usedTokens: 0,
    limitTokens: 0,
    renewsAt: 0,
    expiresAt: 0,
    message: "",
    ...partial,
  };
}

/**
 * Reads the presented key's subscription and this month's counter.
 *
 * The body carries `virtualKey` rather than a header because that is what `ProStatusRequest`
 * declares; the `X-Gestu-Subscription` header is accepted as well so a client that already
 * presents the key that way does not have to duplicate it.
 */
export async function handleSubscriptionStatus(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now = Date.now(),
): Promise<Response> {
  let parsed: StatusRequest;
  try {
    parsed = parseStatusRequest(await request.json(), request);
  } catch (error) {
    if (error instanceof Error && error.name === "HttpError") throw error;
    throw badRequest("body must be JSON");
  }
  if (parsed.virtualKey === "") return jsonResponse(statusResponse({ message: "No subscription key supplied." }));

  let record = await findKeyByVirtualKey(env.PRO_KV, parsed.virtualKey);
  if (record === null) {
    // A revoked key must still be *explainable*: the app shows a different dialog for "your
    // subscription was revoked" than for "this key is unknown", and the tombstone is the only
    // place that distinction survives.
    const tombstone = await getKeyRecord(env.PRO_KV, await sha256Hex(parsed.virtualKey));
    if (tombstone !== null && tombstone.status === STATUS.REVOKED) {
      return jsonResponse(
        statusResponse({
          status: STATUS.REVOKED,
          // Keep explaining *which* plan ended: a revoked Pro key and an unknown key are different
          // support conversations, and the tombstone is the only place that distinction survives.
          plan: planForReport(tombstone, STATUS.REVOKED, false),
          expiresAt: tombstone.expiresAt,
          limitTokens: tombstone.licenceId ? 1_000_000 : monthlyOutputTokenLimitFor(tombstone.productId),
          message: "This subscription was revoked.",
        }),
      );
    }
    return jsonResponse(
      statusResponse({ message: "This subscription key is not recognised. Open Settings to restore your purchase." }),
    );
  }

  if (parsed.deviceId !== "" && !record.devices.some((device) => device.deviceId === parsed.deviceId)) {
    // The key's own cap, not the deployment's: a business licence may have been issued with more
    // seats than `GESTU_DEVICE_LIMIT`, or with none. One value feeds both the pre-check and the
    // binding, so the two cannot disagree about which devices fit.
    const deviceLimit = deviceLimitFor(record, config.deviceLimit);
    if (deviceLimit > 0 && record.devices.length >= deviceLimit) {
      return jsonResponse(
        statusResponse({
          status: statusForReport(record, now),
          expiresAt: record.expiresAt,
          message: `This subscription is active on ${record.devices.length} other devices.`,
        }),
      );
    }
    const bound = await bindDevice({
      kv: env.PRO_KV,
      record,
      deviceId: parsed.deviceId,
      deviceLimit,
      now,
    });
    if (bound.kind !== "limit_reached") record = bound.record;
  }

  let quota: QuotaSnapshot;
  let quotaUnit: "ppm" | "tokens" =
    record.productId === PRODUCT_ID_FREE ? "tokens" : record.quotaUnit ?? (record.licenceId ? "ppm" : "tokens");
  let quotaMode: "normal" | "reduced" = "normal";
  let inputTokensUsed = 0;
  let inputTokensLimit = monthlyInputTokenLimitFor(record.productId);
  let outputTokensUsed = 0;
  let outputTokensLimit = monthlyOutputTokenLimitFor(record.productId);

  if (record.licenceId && hasLiveLicenceMeter(env)) {
    const summary = await callLicenceMeter<LicenceUsageSummary>(
      env.LICENCE_METER,
      record.licenceId,
      "getUsage",
      { now },
    );
    // Durable-Object-backed Free and Pro keys are metered in USD cost-ppm against their
    // dollar budget ($0.50 USD Free trial cap, $10.00 USD/mo Pro) rather than a fixed token count.
    quota = {
      periodId: summary.periodId,
      usedTokens: summary.usedPpm,
      limitTokens: summary.limitPpm,
      renewsAt: summary.renewsAt,
    };
    quotaUnit = "ppm";
    quotaMode = summary.mode;
    inputTokensUsed = summary.inputTokens;
    inputTokensLimit = summary.monthlyInputTokenLimit;
    outputTokensUsed = summary.outputTokens;
    outputTokensLimit = summary.monthlyOutputTokenLimit;
  } else {
    // The Free meter is keyed by the device's stable meter id, not the rotating key id, and the
    // number the app mirrors for a token-metered key is the **output** allowance the plan
    // advertises — the same pair the proxy puts in `X-Gestu-Quota-*`.
    const meterId = record.meterId ?? record.keyId;
    const combined = await readQuota(env.PRO_KV, meterId, tokenLimitFor(record.productId, config), now);
    const tierUsage = await readTierUsage(env.PRO_KV, meterId, now);
    quota = {
      periodId: combined.periodId,
      usedTokens: tierUsage.outputTokens,
      limitTokens: monthlyOutputTokenLimitFor(record.productId),
      renewsAt: combined.renewsAt,
    };
    inputTokensUsed = tierUsage.inputTokens;
    outputTokensUsed = tierUsage.outputTokens;
  }

  const status = statusForReport(record, now);
  const entitled = isGrantActive(record.status, record.expiresAt, now);
  return jsonResponse(
    statusResponse({
      ok: true,
      plan: planForReport(record, status, entitled),
      status,
      periodId: quota.periodId,
      usedTokens: quota.usedTokens,
      limitTokens: quota.limitTokens,
      renewsAt: quota.renewsAt,
      expiresAt: record.expiresAt,
      quotaUnit,
      quotaMode,
      inputTokensUsed,
      inputTokensLimit,
      outputTokensUsed,
      outputTokensLimit,
      message: entitled ? "" : "This subscription is no longer active.",
    }),
  );
}

/**
 * The plan the account host reports.
 *
 * It is derived from the key's **product tier**, not from "has any status": a Free managed key is
 * live (`status: active`) by design, and reporting it as Pro because an entitlement exists would put
 * the wrong plan name in front of a Free user. Only a Pro product id can ever report `pro`, and only
 * while it is (or was) entitled.
 */
export function planForReport(record: KeyRecord, status: SubscriptionStatusId, entitled: boolean): string {
  if (tierForProductId(record.productId) !== PLAN_PRO) return PLAN_FREE;
  return entitled || wasEverEntitled(status) ? PLAN_PRO : PLAN_FREE;
}

/**
 * Reports `expired` for a record whose status still says active but whose paid period has run out.
 *
 * The record is only rewritten by RTDN; a missed notification must not leave the account host
 * claiming a live plan, so this reports the state the timestamps actually imply.
 */
function statusForReport(record: KeyRecord, now: number): SubscriptionStatusId {
  if (
    (record.status === STATUS.ACTIVE || record.status === STATUS.GRACE || record.status === STATUS.CANCELED) &&
    record.expiresAt > 0 &&
    record.expiresAt <= now
  ) {
    return STATUS.EXPIRED;
  }
  return record.status;
}

function wasEverEntitled(status: SubscriptionStatusId): boolean {
  return status !== STATUS.NONE;
}

/** Parses the status body, falling back to the subscription header for the key. */
export function parseStatusRequest(raw: unknown, request: Request): StatusRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("body must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  const fromBody = typeof record["virtualKey"] === "string" ? record["virtualKey"].trim() : "";
  const fromHeader = presentedKey(request);
  return {
    virtualKey: fromBody !== "" ? fromBody : fromHeader,
    deviceId: typeof record["deviceId"] === "string" ? record["deviceId"].trim() : "",
  };
}

// ---------------------------------------------------------------------------------------------
// Real-time Developer Notifications
// ---------------------------------------------------------------------------------------------

/** The Pub/Sub push envelope. */
export interface PubSubPushEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

/** Prefix for RTDN replay markers; a short TTL is all the dedupe needs. */
const RTDN_SEEN_PREFIX = "rtdn:seen:";

/**
 * Decodes the base64 body of a Pub/Sub push message.
 *
 * Throws a 400 for anything that is not a decodable envelope: a push endpoint that answers 200 to
 * garbage teaches Google to keep sending garbage.
 */
export function decodePubSubEnvelope(raw: unknown): { decoded: DecodedRtdn; messageId: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw badRequest("body must be a Pub/Sub push envelope");
  }
  const envelope = raw as PubSubPushEnvelope;
  const message = envelope.message;
  if (message === undefined || message === null || typeof message.data !== "string") {
    throw badRequest("envelope has no message.data");
  }
  let text: string;
  try {
    text = new TextDecoder().decode(base64UrlDecode(message.data));
  } catch {
    throw badRequest("message.data is not valid base64");
  }
  let payload: RtdnPayload;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    payload = parsed as RtdnPayload;
  } catch {
    throw badRequest("message.data is not a JSON payload");
  }
  return {
    decoded: classifyRtdn(payload),
    messageId: typeof message.messageId === "string" ? message.messageId : "",
  };
}

/**
 * `POST /api/rtdn` — Play subscription state changes, pushed through Pub/Sub.
 *
 * Authentication: when `RTDN_AUDIENCE` is set, the request must carry a Pub/Sub OIDC bearer token
 * with that audience and a valid Google signature; otherwise the request is refused with 401.
 * **Configure an audience before going live.** Until it is set the endpoint accepts unauthenticated
 * posts, which is only tolerable during bootstrap because the handler acts solely on Play's own
 * state for tokens it already knows about: the worst an attacker can do without a valid token is
 * force a re-verification, not create or extend an entitlement.
 *
 * Answers 200 for everything it has dealt with (including ignored notification kinds) so Pub/Sub
 * stops redelivering, and 5xx only when the work genuinely did not happen.
 */
export async function handleRtdn(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now = Date.now(),
): Promise<Response> {
  if (config.rtdnAudience === "") {
    console.error(
      "rtdn: RTDN_AUDIENCE is not set — refusing unauthenticated push (fail closed). " +
        "Set the var to the Pub/Sub push audience before relying on RTDN.",
    );
    return jsonResponse(
      { ok: false, error: "server_misconfigured", message: "RTDN endpoint is not configured." },
      { status: 503 },
    );
  }

  const authResult = await verifyPubSubOidcToken({
    authorizationHeader: request.headers.get("authorization"),
    audience: config.rtdnAudience,
    now,
  });
  if (!authResult.ok) {
    console.warn(`rtdn: rejected unauthenticated push (${authResult.detail})`);
    return jsonResponse({ ok: false, error: "unauthenticated" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw badRequest("body must be JSON");
  }
  const { decoded, messageId } = decodePubSubEnvelope(raw);

  if (decoded.kind === "test") {
    console.log("rtdn: test notification received");
    return jsonResponse({ ok: true, handled: "test" });
  }

  if (decoded.packageName !== "" && !config.allowedPackageNames.includes(decoded.packageName)) {
    console.warn(`rtdn: ignoring notification for package ${decoded.packageName}`);
    return jsonResponse({ ok: true, handled: "ignored_package" });
  }

  if (decoded.kind !== "subscription" && decoded.kind !== "voided") {
    // One-time products and chargeback reviews are not this plan's business, but the message must
    // still be acknowledged or Pub/Sub will redeliver it forever.
    return jsonResponse({ ok: true, handled: `ignored_${decoded.kind}` });
  }
  if (decoded.purchaseToken === "") {
    return jsonResponse({ ok: true, handled: "ignored_no_token" });
  }

  if (messageId !== "" && (await alreadyHandled(env, messageId))) {
    // Pub/Sub guarantees at-least-once delivery; the marker makes the handler effectively once.
    return jsonResponse({ ok: true, handled: "duplicate" });
  }

  const tokenHash = await purchaseTokenHash(decoded.purchaseToken);
  const purchase = await getPurchaseRecord(env.PRO_KV, tokenHash);
  if (purchase === null) {
    // A purchase this Worker never provisioned (a licence tester, a purchase made before RTDN was
    // wired, or the other app in a shared project). Acknowledged and dropped.
    console.log(`rtdn: no key linked to token ${shortHash(tokenHash)} (${decoded.notificationName})`);
    await markHandled(env, messageId);
    return jsonResponse({ ok: true, handled: "unknown_token" });
  }

  const terminal = terminalStateFromNotification(decoded.notificationType);
  if (terminal !== null) {
    // Non-revocation terminal states (e.g. EXPIRED) are acted on from the notification itself.
    // Negative notifications (voided, revoked) must be verified against Play before revoking keys.
    await updateKeyStatus(env.PRO_KV, purchase.keyId, { status: terminal.status }, now);
    await markHandled(env, messageId);
    console.log(
      `rtdn: ${decoded.notificationName} applied to ${shortId(purchase.keyId)} — status ${terminal.status}`,
    );
    return jsonResponse({ ok: true, handled: decoded.notificationName });
  }

  // Everything else is confirmed against Play rather than trusted: delivery is at-least-once and
  // out of order, so `SUBSCRIPTION_PURCHASED` arriving after `SUBSCRIPTION_CANCELED` must not
  // re-grant access.
  const verification = await verifySubscriptionPurchase({
    env,
    config,
    packageName: decoded.packageName !== "" ? decoded.packageName : purchase.packageName,
    token: decoded.purchaseToken,
    tokenHash,
    now,
  });

  if (!verification.ok) {
    if (verification.failure.kind === "not_found") {
      await updateKeyStatus(env.PRO_KV, purchase.keyId, { status: STATUS.REVOKED }, now);
      await markHandled(env, messageId);
      console.log(`rtdn: Play no longer knows token ${shortHash(tokenHash)} — key revoked`);
      return jsonResponse({ ok: true, handled: "not_found" });
    }
    // Transient: let Pub/Sub redeliver instead of acknowledging a change we did not apply.
    console.error(
      `rtdn: could not confirm ${decoded.notificationName} for ${shortHash(tokenHash)} (${verification.failure.kind}) — asking Pub/Sub to retry`,
    );
    return jsonResponse({ ok: false, error: "retry" }, { status: 503 });
  }

  const lineItems = verification.purchase.lineItems ?? [];
  const grant = grantFromPurchase(verification.purchase, now);
  const productMatches = hasLineItemForProduct(lineItems, config.productId);

  // A negative notification (refund/chargeback/voided/revoked) can arrive for a purchase that Play
  // now reports with **no line items at all** — the item is gone, not re-attributed. Refusing on a
  // product mismatch would then leave the key live after Play stopped recognising the entitlement,
  // which is exactly the case a refund must end. So the product check only guards *granting*:
  // when Play still says entitled and the item cannot be attributed, nothing is changed.
  if (!productMatches && grant.entitled) {
    console.warn(`rtdn: token ${shortHash(tokenHash)} has no line item for ${config.productId}; ignoring`);
    await markHandled(env, messageId);
    return jsonResponse({ ok: true, handled: "product_mismatch" });
  }

  const record = await getKeyRecord(env.PRO_KV, purchase.keyId);
  if (grant.status === STATUS.REVOKED || !grant.entitled) {
    await revokeKey(env.PRO_KV, purchase.keyId, grant.status, now);
  } else {
    await updateKeyStatus(
      env.PRO_KV,
      purchase.keyId,
      {
        status: grant.status,
        expiresAt: grant.expiresAt,
        playState: grant.playState,
      },
      now,
    );
  }
  await markHandled(env, messageId);
  console.log(
    `rtdn: ${decoded.notificationName} confirmed by Play → ${shortId(purchase.keyId)} status ${grant.status}` +
      (record === null ? " (record was missing)" : "") +
      (productMatches ? "" : " (no matching line item; acted on Play state)"),
  );
  return jsonResponse({ ok: true, handled: decoded.notificationName });
}

async function alreadyHandled(env: Env, messageId: string): Promise<boolean> {
  try {
    const marker = await env.PRO_KV.get(`${RTDN_SEEN_PREFIX}${messageId}`);
    return marker !== null;
  } catch (error) {
    // Losing the marker risks reprocessing a notification, which the handler tolerates (it is
    // idempotent); failing the request would be worse.
    console.warn(`rtdn: dedupe lookup failed (${describeError(error)})`);
    return false;
  }
}

async function markHandled(env: Env, messageId: string): Promise<void> {
  if (messageId === "") return;
  try {
    // 24 h is far longer than Pub/Sub's redelivery window; the TTL keeps the marker from
    // accumulating.
    await env.PRO_KV.put(`${RTDN_SEEN_PREFIX}${messageId}`, "1", { expirationTtl: 86_400 });
  } catch (error) {
    console.warn(`rtdn: could not record the dedupe marker (${describeError(error)})`);
  }
}
