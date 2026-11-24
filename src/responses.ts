/**
 * JSON response shapes, quota headers, and the error vocabulary.
 *
 * The rule this file exists to enforce: **the client's error vocabulary is fixed**. The app maps
 * `401` → invalid key, `402` → quota exhausted, `403` → content moderation, `429` → rate limit
 * (`Requests.kt`, `handleOpenAICompatibleError`), and its out-of-credit flow keys off the `429`
 * plus the `X-Gestu-Quota-*` headers. So:
 *
 *  * budget spent          → **429** with the quota headers (the one code the app reads as "buy
 *                            more or switch to BYOK");
 *  * lapsed subscription   → **403** with a `reason` in the body — deliberately *not* 401 (which
 *                            would read as "your key is wrong" and send the app looking for a new
 *                            one) and *not* 402 (which the app treats as an empty budget);
 *  * unknown/absent key    → **401**;
 *  * everything else       → 200 `{ok:false,reason}` on the account endpoints, 5xx on transient
 *                            upstream failures so the client retries instead of giving up.
 */

import type { DenialReason } from "./constants";

/** Any browser origin the operator has explicitly allowed; empty by default (native client). */
export function corsHeaders(allowedOrigins: string[], requestOrigin: string | null): Record<string, string> {
  if (requestOrigin === null || requestOrigin === "") return {};
  if (!allowedOrigins.includes(requestOrigin)) {
    // Not an error the client ever sees: a browser will simply refuse to hand the response to the
    // page. Refusing unknown origins matters because a virtual key in a web page is a key that
    // can be spent by any script on it.
    return {};
  }
  return {
    "access-control-allow-origin": requestOrigin,
    "access-control-allow-headers": "authorization, content-type, x-gestu-subscription",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/** Serialises `body` as JSON with the given status and headers. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

/** The account-endpoint error body. `reason` is what the client switches on. */
export interface JsonErrorBody {
  ok: false;
  reason: DenialReason;
  message: string;
}

/**
 * An error that already knows its HTTP answer.
 *
 * Thrown from deep inside a handler and converted once at the router boundary, so no helper has
 * to thread a `Response` back up through five call frames.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** 400 with a plain JSON body — for malformed requests, never for refusals. */
export function badRequest(message: string): HttpError {
  return new HttpError(400, { ok: false, error: "bad_request", message }, message);
}

/** 500 for a misconfiguration or an internal invariant, with the detail kept server-side. */
export function serverError(message: string, internalDetail: string): HttpError {
  console.error(`internal: ${message}: ${internalDetail}`);
  return new HttpError(
    500,
    { ok: false, error: "server_error", message },
    message,
  );
}

/**
 * The `X-Gestu-Quota-*` header block.
 *
 * Sent on proxied answers *and* on the 429 that ends the month, because that 429 is the app's
 * authoritative quota reading: `QuotaGate.noteProxyRejection` adopts these values over its own
 * mirror. The values describe the state as the proxy counted it *before* the request that carries
 * them (streaming answers cannot know their own final count when the head is written) — the
 * request's own tokens are added as its last chunk goes past.
 */
export interface QuotaHeaderInput {
  usedTokens: number;
  limitTokens: number;
  periodId: string;
  renewsAt: number;
  unit?: "ppm" | "tokens";
  mode?: "normal" | "reduced";
  inputTokensUsed?: number;
  inputTokensLimit?: number;
  outputTokensUsed?: number;
  outputTokensLimit?: number;
}

export function quotaHeaders(quota: QuotaHeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Gestu-Quota-Used": String(Math.max(0, Math.trunc(quota.usedTokens))),
    "X-Gestu-Quota-Limit": String(Math.max(0, Math.trunc(quota.limitTokens))),
    "X-Gestu-Quota-Period": quota.periodId,
    "X-Gestu-Quota-Renews-At": String(Math.max(0, Math.trunc(quota.renewsAt))),
    "X-Gestu-Quota-Unit": quota.unit ?? "ppm",
    "X-Gestu-Quota-Mode": quota.mode ?? "normal",
  };
  if (typeof quota.inputTokensUsed === "number" && Number.isFinite(quota.inputTokensUsed)) {
    headers["X-Gestu-Quota-Input-Used"] = String(Math.max(0, Math.trunc(quota.inputTokensUsed)));
  }
  if (typeof quota.inputTokensLimit === "number" && Number.isFinite(quota.inputTokensLimit)) {
    headers["X-Gestu-Quota-Input-Limit"] = String(Math.max(0, Math.trunc(quota.inputTokensLimit)));
  }
  if (typeof quota.outputTokensUsed === "number" && Number.isFinite(quota.outputTokensUsed)) {
    headers["X-Gestu-Quota-Output-Used"] = String(Math.max(0, Math.trunc(quota.outputTokensUsed)));
  }
  if (typeof quota.outputTokensLimit === "number" && Number.isFinite(quota.outputTokensLimit)) {
    headers["X-Gestu-Quota-Output-Limit"] = String(Math.max(0, Math.trunc(quota.outputTokensLimit)));
  }
  return headers;
}

/**
 * The `429` that ends the month.
 *
 * Body shape is the OpenAI error envelope, because the app parses responses with the
 * OpenAI-compatible error reader (`parseOpenAICompatibleErrorDetail`) and puts `error.message` in
 * front of the user verbatim. `code` and `type` are the machine-readable markers; `X-Gestu-Quota-*`
 * carry the numbers.
 */
export function quotaExceededResponse(
  quota: QuotaHeaderInput,
  headers: Record<string, string> = {},
  customMessage?: string,
  customCode = "quota_exceeded",
): Response {
  const message =
    customMessage ??
    `Gestu managed cloud allowance for ${quota.periodId} is used up ` +
      `(${quota.usedTokens} of ${quota.limitTokens}). The allowance resets on the 1st.`;
  return jsonResponse(
    {
      error: {
        message,
        type: "gestu_quota_exceeded",
        code: customCode,
        param: null,
      },
    },
    { status: 429, headers: { ...quotaHeaders(quota), ...headers } },
  );
}

/**
 * The `429` for an anti-abuse rate limit (not an exhausted allowance).
 *
 * It carries the same `X-Gestu-Quota-*` block as every other proxy answer, because the app mirrors
 * the counter from these headers; the numbers are the unchanged pre-request state, so the app's
 * out-of-credit flow sees `used < limit` and treats this as the transient throttle it is.
 * `Retry-After` says how long the window has left. Nothing here names the limiter or the caller's
 * address.
 */
export function rateLimitedResponse(
  quota: QuotaHeaderInput,
  retryAfterSeconds: number,
  message = "Too many requests. Please wait a moment and try again.",
): Response {
  return jsonResponse(
    {
      error: {
        message,
        type: "gestu_rate_limited",
        code: "rate_limited",
        param: null,
      },
    },
    {
      status: 429,
      headers: {
        ...quotaHeaders(quota),
        "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
      },
    },
  );
}

/**
 * The `403` for a subscription that is no longer entitled.
 *
 * 403 is the code the app maps to content moderation, which sounds wrong until the alternative is
 * considered: 401 tells the app its key is invalid (it would re-provision and get the same
 * answer), and 402 tells it the month's tokens are gone (it would show the buy-more dialog to
 * someone whose subscription ended). The body therefore carries a recognizable `code` so the
 * distinction is available to any client that looks, and the prose says plainly what happened.
 */
export function subscriptionInactiveResponse(
  reason: DenialReason,
  message: string,
  headers: Record<string, string> = {},
): Response {
  console.warn(`subscription inactive (${reason})`);
  return jsonResponse(
    {
      error: {
        message,
        type: "gestu_subscription_inactive",
        code: "subscription_inactive",
        reason,
        param: null,
      },
    },
    { status: 403, headers },
  );
}
