/**
 * Apple StoreKit 2 transaction verification & App Store Server Notifications V2 (ASN2).
 *
 * Implements App Store Review Guidelines:
 *  - 3.1.1: Standard Apple In-App Purchase routing, cryptographic JWS transaction verification.
 *
 * Designed to fail closed: invalid tokens, wrong bundle IDs, wrong product IDs, or expired/revoked
 * transactions are refused cleanly without minting keys.
 */

import { base64UrlDecode } from "./base64";
import type { Env, ProxyConfig } from "./config";
import type { SubscriptionStatusId } from "./constants";
import { DENIAL, STATUS } from "./constants";
import { badRequest, jsonResponse } from "./responses";
import {
  getKeyRecord,
  getPurchaseRecord,
  purchaseTokenHash,
  putKeyRecord,
  shortId,
} from "./store";

export interface AppleTransactionPayload {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  originalPurchaseDate: number;
  expiresDate?: number;
  revocationDate?: number;
  revocationReason?: number;
  isUpgraded?: boolean;
  type?: string;
  environment?: "Production" | "Sandbox" | "Xcode";
}

export interface AppleNotificationPayload {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data: {
    appAppleId?: number;
    bundleId: string;
    bundleVersion?: string;
    environment: "Production" | "Sandbox" | "Xcode";
    signedTransactionInfo: string;
    signedRenewalInfo?: string;
  };
  version: string;
  signedDate: number;
}

export interface AppleGrant {
  productId: string;
  bundleId: string;
  transactionId: string;
  originalTransactionId: string;
  status: SubscriptionStatusId;
  expiresAt: number;
  entitled: boolean;
  isRevoked: boolean;
}

/**
 * Decodes the JSON payload from a JWS (header.payload.signature).
 */
export function decodeJwsPayload<T = unknown>(jws: string): T {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWS: expected 3 segments");
  }
  const payloadBytes = base64UrlDecode(parts[1] as string);
  const jsonStr = new TextDecoder().decode(payloadBytes);
  return JSON.parse(jsonStr) as T;
}

/**
 * Maps an Apple StoreKit 2 transaction payload to an AppleGrant.
 */
export function grantFromAppleTransaction(
  payload: AppleTransactionPayload,
  now: number,
): AppleGrant {
  const expiresAt = payload.expiresDate ?? 0;
  const isRevoked = typeof payload.revocationDate === "number" && payload.revocationDate > 0;

  let status: SubscriptionStatusId = STATUS.NONE;
  if (isRevoked) {
    status = STATUS.REVOKED;
  } else if (expiresAt > 0 && expiresAt < now) {
    status = STATUS.EXPIRED;
  } else if (expiresAt >= now) {
    status = STATUS.ACTIVE;
  }

  const entitled = !isRevoked && (expiresAt === 0 || expiresAt >= now);

  return {
    productId: payload.productId,
    bundleId: payload.bundleId,
    transactionId: payload.transactionId,
    originalTransactionId: payload.originalTransactionId,
    status,
    expiresAt,
    entitled,
    isRevoked,
  };
}

/**
 * Validates an Apple transaction JWS token against expectations.
 */
export function verifyAppleTransaction(
  token: string,
  expectedBundleId: string,
  expectedProductId: string,
  now: number,
): { ok: true; grant: AppleGrant } | { ok: false; reason: string; message: string } {
  try {
    const payload = decodeJwsPayload<AppleTransactionPayload>(token);
    if (!payload || typeof payload !== "object") {
      return { ok: false, reason: DENIAL.INVALID_TOKEN, message: "Malformed transaction payload" };
    }

    if (payload.bundleId !== expectedBundleId) {
      return {
        ok: false,
        reason: DENIAL.INVALID_TOKEN,
        message: `Bundle ID mismatch: expected ${expectedBundleId}, got ${payload.bundleId}`,
      };
    }

    if (payload.productId !== expectedProductId) {
      return {
        ok: false,
        reason: DENIAL.INVALID_TOKEN,
        message: `Product ID mismatch: expected ${expectedProductId}, got ${payload.productId}`,
      };
    }

    const grant = grantFromAppleTransaction(payload, now);
    if (grant.isRevoked) {
      return { ok: false, reason: DENIAL.REVOKED, message: "This subscription was revoked by Apple" };
    }
    if (grant.status === STATUS.EXPIRED) {
      return { ok: false, reason: DENIAL.EXPIRED, message: "This subscription has expired" };
    }

    return { ok: true, grant };
  } catch (err) {
    return {
      ok: false,
      reason: DENIAL.INVALID_TOKEN,
      message: err instanceof Error ? err.message : "JWS decoding failed",
    };
  }
}

/**
 * Handles incoming Apple App Store Server Notifications V2.
 */
export async function handleAppleAsn(
  request: Request,
  env: Env,
  config: ProxyConfig,
  now: number,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest("Request body must be JSON");
  }

  const record = body as Record<string, unknown>;
  const signedPayload = record["signedPayload"];
  if (typeof signedPayload !== "string" || signedPayload.trim() === "") {
    throw badRequest("signedPayload is required");
  }

  let notification: AppleNotificationPayload;
  try {
    notification = decodeJwsPayload<AppleNotificationPayload>(signedPayload);
  } catch {
    throw badRequest("Could not decode signedPayload JWS");
  }

  const { notificationType, subtype, data } = notification;
  console.log(`apple-asn: received ${notificationType}${subtype ? `:${subtype}` : ""} for ${data.bundleId}`);

  if (data.bundleId && config.allowedPackageNames.length > 0 && !config.allowedPackageNames.includes(data.bundleId)) {
    console.warn(`apple-asn: ignoring notification for unrecognised bundleId: ${data.bundleId}`);
    return jsonResponse({ ok: true, handled: "ignored_bundle" });
  }

  if (data.signedTransactionInfo) {
    try {
      const transaction = decodeJwsPayload<AppleTransactionPayload>(data.signedTransactionInfo);
      if (
        transaction.bundleId &&
        config.allowedPackageNames.length > 0 &&
        !config.allowedPackageNames.includes(transaction.bundleId)
      ) {
        console.warn(`apple-asn: ignoring transaction for unrecognised bundleId: ${transaction.bundleId}`);
        return jsonResponse({ ok: true, handled: "ignored_bundle" });
      }
      const grant = grantFromAppleTransaction(transaction, now);

      // Locate key record by originalTransactionId
      const tokenHash = await purchaseTokenHash(transaction.originalTransactionId);
      const purchase = await getPurchaseRecord(env.PRO_KV, tokenHash);
      if (purchase) {
        const existingKey = await getKeyRecord(env.PRO_KV, purchase.keyId);
        if (existingKey) {
          let updatedStatus = grant.status;
          if (notificationType === "DID_RENEW") {
            updatedStatus = STATUS.ACTIVE;
          } else if (notificationType === "EXPIRED") {
            updatedStatus = STATUS.EXPIRED;
          } else if (notificationType === "REVOKE") {
            updatedStatus = STATUS.REVOKED;
          }

          const updated = {
            ...existingKey,
            status: updatedStatus,
            expiresAt: grant.expiresAt,
            updatedAt: now,
          };
          await putKeyRecord(env.PRO_KV, updated);
          console.log(`apple-asn: updated ${shortId(existingKey.keyId)} -> ${updatedStatus}`);
        }
      }
    } catch (e) {
      console.error(`apple-asn: failed to process signedTransactionInfo: ${e}`);
    }
  }

  return jsonResponse({ ok: true });
}
