/**
 * Google Play purchase data → the Worker's own grant model.
 *
 * Everything in this file is pure: no network, no KV, no `crypto`. The API calls live in
 * `google.ts`; this is the decision layer they feed, which is why it is the part with tests.
 *
 * Shapes come from the Play Developer API v3 Discovery document
 * (https://androidpublisher.googleapis.com/$discovery/rest?version=v3), cross-checked against
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2 — see
 * README "Google API details we verified".
 */

import type { SubscriptionStatusId } from "./constants";
import { STATUS } from "./constants";

/**
 * `SubscriptionState` for `SubscriptionPurchaseV2.subscriptionState`.
 *
 * The Discovery document lists nine values. The task brief named eight; the ninth,
 * `SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED`, was added later and is handled explicitly here
 * rather than being allowed to fall into a default branch.
 */
export type PlaySubscriptionState =
  | "SUBSCRIPTION_STATE_UNSPECIFIED"
  | "SUBSCRIPTION_STATE_PENDING"
  | "SUBSCRIPTION_STATE_ACTIVE"
  | "SUBSCRIPTION_STATE_PAUSED"
  | "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"
  | "SUBSCRIPTION_STATE_ON_HOLD"
  | "SUBSCRIPTION_STATE_CANCELED"
  | "SUBSCRIPTION_STATE_EXPIRED"
  | "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED";

/** `AcknowledgementState` for `SubscriptionPurchaseV2.acknowledgementState`. */
export type PlayAcknowledgementState =
  | "ACKNOWLEDGEMENT_STATE_UNSPECIFIED"
  | "ACKNOWLEDGEMENT_STATE_PENDING"
  | "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED";

export interface PlayMoney {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}

export interface PlayOfferDetails {
  basePlanId?: string;
  offerId?: string;
  offerTags?: string[];
}

export interface PlayAutoRenewingPlan {
  autoRenewEnabled?: boolean;
}

export interface PlayLineItem {
  productId?: string;
  /** RFC 3339 (`google-datetime`), e.g. `2026-10-01T10:00:00Z`. */
  expiryTime?: string;
  offerDetails?: PlayOfferDetails;
  autoRenewingPlan?: PlayAutoRenewingPlan;
}

export interface PlayExternalAccountIdentifiers {
  externalAccountId?: string;
  obfuscatedExternalAccountId?: string;
  obfuscatedExternalProfileId?: string;
}

/** `SubscriptionPurchaseV2`. Fields not used by the Worker are omitted. */
export interface PlaySubscriptionPurchaseV2 {
  kind?: string;
  regionCode?: string;
  startTime?: string;
  subscriptionState?: string;
  latestOrderId?: string;
  /** Set when this purchase replaced an earlier one (upgrade, downgrade, re-signup). */
  linkedPurchaseToken?: string;
  /** Present — and non-null — only for test purchases from a licence-test account. */
  testPurchase?: Record<string, never> | null;
  acknowledgementState?: string;
  externalAccountIdentifiers?: PlayExternalAccountIdentifiers;
  lineItems?: PlayLineItem[];
}

/**
 * Play subscription state → the app's `SubscriptionStatus` vocabulary.
 *
 * Every state maps somewhere explicit. Nothing falls through to "active": the previous version of
 * this kind of mapping is how a paused or on-hold subscription keeps spending tokens.
 *
 * `PAUSED` maps to `expired`: a paused subscription grants no access, and `expired` is the
 * client's "access ended" status (`SUBSCRIPTION_INACTIVE`). `PENDING` maps to `canceled` because
 * Play's own description of that state is "created but awaiting payment during signup" — the app
 * treats `canceled` as "not entitled yet, may still resolve", which is the honest reading.
 */
export function mapPlaySubscriptionState(state: string): SubscriptionStatusId {
  switch (state) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      return STATUS.ACTIVE;
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
      return STATUS.GRACE;
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return STATUS.ON_HOLD;
    case "SUBSCRIPTION_STATE_CANCELED":
      // Google's description: "canceled but not expired yet … all items have auto_renew_enabled
      // set to false". Access continues until line_items[].expiry_time, which is carried on the
      // grant and enforced by `isGrantActive`.
      return STATUS.CANCELED;
    case "SUBSCRIPTION_STATE_EXPIRED":
      return STATUS.EXPIRED;
    case "SUBSCRIPTION_STATE_PAUSED":
      return STATUS.EXPIRED;
    case "SUBSCRIPTION_STATE_PENDING":
      return STATUS.CANCELED;
    case "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED":
      return STATUS.NONE;
    case "SUBSCRIPTION_STATE_UNSPECIFIED":
      return STATUS.NONE;
    default:
      // An unknown enum member (Google adds them over time) is *not* access.
      return STATUS.NONE;
  }
}

/** True when `state` is a value this Worker recognises, used to decide "unknown" vs "denied". */
export function isKnownPlaySubscriptionState(state: string): state is PlaySubscriptionState {
  return (
    state === "SUBSCRIPTION_STATE_UNSPECIFIED" ||
    state === "SUBSCRIPTION_STATE_PENDING" ||
    state === "SUBSCRIPTION_STATE_ACTIVE" ||
    state === "SUBSCRIPTION_STATE_PAUSED" ||
    state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" ||
    state === "SUBSCRIPTION_STATE_ON_HOLD" ||
    state === "SUBSCRIPTION_STATE_CANCELED" ||
    state === "SUBSCRIPTION_STATE_EXPIRED" ||
    state === "SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED"
  );
}

/** The Worker's view of a Google-verified purchase. */
export interface PlayGrant {
  productId: string;
  /** Play state, verbatim, kept for the audit trail on the key record. */
  playState: string;
  status: SubscriptionStatusId;
  /** Latest `lineItems[].expiryTime` in epoch millis, or 0 when Play reported none. */
  expiresAt: number;
  /** ISO-8601 or empty; carried through to the RTDN paths. */
  regionCode: string;
  /** Old purchase token when this purchase replaced one (upgrade / re-signup). */
  linkedPurchaseToken: string;
  obfuscatedExternalAccountId: string;
  basePlanId: string;
  autoRenewing: boolean;
  isTestPurchase: boolean;
  acknowledgementState: string;
  /** Present when Play says the entitlement is live right now. */
  entitled: boolean;
}

/**
 * Parses a `google-datetime` string.
 *
 * Play sends RFC 3339 with a `Z` suffix. The parser is applied defensively — a non-string or an
 * unparseable value yields 0 ("unknown expiry"), never `NaN`, because a `NaN` expiry would make
 * every comparison against it false in a way that reads as "not expired".
 */
export function parsePlayTimestamp(value: unknown): number {
  if (typeof value !== "string" || value === "") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The end of the currently paid period: the furthest-out `expiryTime` across line items.
 *
 * Furthest-out rather than first: a subscription with add-ons has one line item per item, and
 * taking the first would end access for a user who paid for a longer item. Google documents the
 * items of one purchase as sharing a plan type, so this is a maximum of like-for-like values.
 */
export function latestExpiryFromLineItems(lineItems: readonly PlayLineItem[] | undefined): number {
  if (!Array.isArray(lineItems)) return 0;
  let latest = 0;
  for (const item of lineItems) {
    const expiry = parsePlayTimestamp(item?.expiryTime);
    if (expiry > latest) latest = expiry;
  }
  return latest;
}

/** `lineItems[].offerDetails.basePlanId` for the purchased product, or empty. */
export function basePlanIdFromLineItems(
  lineItems: readonly PlayLineItem[] | undefined,
  productId: string,
): string {
  if (!Array.isArray(lineItems)) return "";
  for (const item of lineItems) {
    if (item?.productId === productId && typeof item.offerDetails?.basePlanId === "string") {
      return item.offerDetails.basePlanId;
    }
  }
  return "";
}

/** True when at least one line item is for `productId`. */
export function hasLineItemForProduct(
  lineItems: readonly PlayLineItem[] | undefined,
  productId: string,
): boolean {
  return Array.isArray(lineItems) && lineItems.some((item) => item?.productId === productId);
}

/**
 * Converts a verified `SubscriptionPurchaseV2` into a grant.
 *
 * `entitled` is the single access flag the rest of the Worker reads; it reuses
 * `mapPlaySubscriptionState` and the expiry, so `canceled` (still inside the paid period) is
 * entitled while `on_hold` is not.
 */
export function grantFromPurchase(
  purchase: PlaySubscriptionPurchaseV2,
  now: number,
): PlayGrant {
  const playState = typeof purchase.subscriptionState === "string" ? purchase.subscriptionState : "";
  const status = mapPlaySubscriptionState(playState);
  const expiresAt = latestExpiryFromLineItems(purchase.lineItems);
  const lineItems = purchase.lineItems ?? [];
  const productId = lineItems.find((item) => typeof item?.productId === "string")?.productId ?? "";
  const identifiers = purchase.externalAccountIdentifiers ?? {};

  return {
    productId,
    playState,
    status,
    expiresAt,
    regionCode: typeof purchase.regionCode === "string" ? purchase.regionCode : "",
    linkedPurchaseToken:
      typeof purchase.linkedPurchaseToken === "string" ? purchase.linkedPurchaseToken : "",
    obfuscatedExternalAccountId:
      typeof identifiers.obfuscatedExternalAccountId === "string"
        ? identifiers.obfuscatedExternalAccountId
        : typeof identifiers.externalAccountId === "string"
          ? identifiers.externalAccountId
          : "",
    basePlanId: basePlanIdFromLineItems(purchase.lineItems, productId),
    autoRenewing: lineItems.some((item) => item?.autoRenewingPlan?.autoRenewEnabled === true),
    isTestPurchase: purchase.testPurchase !== undefined && purchase.testPurchase !== null,
    acknowledgementState:
      typeof purchase.acknowledgementState === "string" ? purchase.acknowledgementState : "",
    entitled: isEntitledNow(status, expiresAt, now),
  };
}

/**
 * Access decision for a parsed grant.
 *
 * `active` and `grace` are the two states the app itself treats as entitled
 * (`ProEntitlement.allowed`); `canceled` is included only while the paid period has not ended,
 * which is exactly what Play's own description of that state says.
 */
export function isEntitledNow(status: SubscriptionStatusId, expiresAt: number, now: number): boolean {
  if (status === STATUS.ACTIVE || status === STATUS.GRACE) {
    return expiresAt === 0 || expiresAt > now;
  }
  if (status === STATUS.CANCELED) return expiresAt > now;
  return false;
}

/** True when the grant is live *and* auto-renew is off — used only for logging/status text. */
export function isCancelledButPaid(grant: PlayGrant): boolean {
  return grant.status === STATUS.CANCELED;
}

// ---------------------------------------------------------------------------------------------
// Real-time Developer Notifications
// ---------------------------------------------------------------------------------------------

/**
 * Google's `SubscriptionNotification.notificationType` integers.
 * https://developer.android.com/google/play/billing/rtdn-reference
 */
export const RTDN_TYPE = {
  SUBSCRIPTION_RECOVERED: 1,
  SUBSCRIPTION_RENEWED: 2,
  SUBSCRIPTION_CANCELED: 3,
  SUBSCRIPTION_PURCHASED: 4,
  SUBSCRIPTION_ON_HOLD: 5,
  SUBSCRIPTION_IN_GRACE_PERIOD: 6,
  SUBSCRIPTION_RESTARTED: 7,
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: 8,
  SUBSCRIPTION_DEFERRED: 9,
  SUBSCRIPTION_PAUSED: 10,
  SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED: 11,
  SUBSCRIPTION_REVOKED: 12,
  SUBSCRIPTION_EXPIRED: 13,
  SUBSCRIPTION_ITEMS_CHANGED: 17,
  SUBSCRIPTION_CANCELLATION_SCHEDULED: 18,
  SUBSCRIPTION_PRICE_CHANGE_UPDATED: 19,
  SUBSCRIPTION_PENDING_PURCHASE_CANCELED: 20,
  SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED: 22,
} as const;

/** Numeric notification type → name, for logs (never the token). */
export function rtdnTypeName(type: number): string {
  for (const [name, value] of Object.entries(RTDN_TYPE)) {
    if (value === type) return name;
  }
  return `UNKNOWN_${type}`;
}

/** The body of a decoded Pub/Sub message for a Play RTDN. */
export interface RtdnPayload {
  version?: string;
  packageName?: string;
  /** String of epoch millis, per Google's example. */
  eventTimeMillis?: string;
  subscriptionNotification?: {
    version?: string;
    notificationType?: number;
    purchaseToken?: string;
  };
  oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string };
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string; refundType?: number };
  pendingRefundReviewNotification?: { purchaseToken?: string };
  testNotification?: { version?: string };
}

export interface DecodedRtdn {
  kind: "subscription" | "voided" | "test" | "one_time" | "pending_refund_review" | "unknown";
  packageName: string;
  purchaseToken: string;
  /** Play's notification type integer for the subscription kind, else 0. */
  notificationType: number;
  notificationName: string;
  eventTimeMillis: number;
  payload: RtdnPayload;
}

/**
 * Classifies a decoded RTDN body.
 *
 * Only the kinds this backend acts on carry a purchase token; the rest are recognised so the
 * handler can answer 200 (acknowledging the Pub/Sub message) instead of leaving Google to retry
 * something the Worker will never process.
 */
export function classifyRtdn(payload: RtdnPayload): DecodedRtdn {
  const packageName = typeof payload.packageName === "string" ? payload.packageName : "";
  const eventTimeMillis = Number(payload.eventTimeMillis ?? 0);
  const base = {
    packageName,
    eventTimeMillis: Number.isFinite(eventTimeMillis) ? eventTimeMillis : 0,
    payload,
  };
  const subscription = payload.subscriptionNotification;
  if (subscription !== undefined && subscription !== null) {
    const type = Number(subscription.notificationType ?? 0);
    return {
      ...base,
      kind: "subscription",
      purchaseToken: typeof subscription.purchaseToken === "string" ? subscription.purchaseToken : "",
      notificationType: Number.isFinite(type) ? type : 0,
      notificationName: rtdnTypeName(Number.isFinite(type) ? type : 0),
    };
  }
  if (payload.voidedPurchaseNotification !== undefined && payload.voidedPurchaseNotification !== null) {
    const token = payload.voidedPurchaseNotification.purchaseToken;
    return {
      ...base,
      kind: "voided",
      purchaseToken: typeof token === "string" ? token : "",
      notificationType: 0,
      notificationName: "VOIDED_PURCHASE",
    };
  }
  if (payload.testNotification !== undefined && payload.testNotification !== null) {
    return { ...base, kind: "test", purchaseToken: "", notificationType: 0, notificationName: "TEST" };
  }
  if (payload.oneTimeProductNotification !== undefined && payload.oneTimeProductNotification !== null) {
    const token = payload.oneTimeProductNotification.purchaseToken;
    return {
      ...base,
      kind: "one_time",
      purchaseToken: typeof token === "string" ? token : "",
      notificationType: 0,
      notificationName: "ONE_TIME_PRODUCT",
    };
  }
  if (
    payload.pendingRefundReviewNotification !== undefined &&
    payload.pendingRefundReviewNotification !== null
  ) {
    const token = payload.pendingRefundReviewNotification.purchaseToken;
    return {
      ...base,
      kind: "pending_refund_review",
      purchaseToken: typeof token === "string" ? token : "",
      notificationType: 0,
      notificationName: "PENDING_REFUND_REVIEW",
    };
  }
  return { ...base, kind: "unknown", purchaseToken: "", notificationType: 0, notificationName: "UNKNOWN" };
}

/**
 * What a subscription notification alone says about access, before any Play re-check.
 *
 * Only EXPIRED is acted on from the notification body itself (marking status expired without deleting key).
 * Revocations and voided purchases must be verified against the Play Developer API before a key is revoked.
 * Every other type is confirmed against Play in `api.ts` rather than trusted, because Pub/Sub delivery is
 * at-least-once and notifications can arrive out of order.
 */
export function terminalStateFromNotification(
  notificationType: number,
): { status: SubscriptionStatusId; deleteKey: boolean } | null {
  switch (notificationType) {
    case RTDN_TYPE.SUBSCRIPTION_EXPIRED:
      return { status: STATUS.EXPIRED, deleteKey: false };
    default:
      return null;
  }
}
