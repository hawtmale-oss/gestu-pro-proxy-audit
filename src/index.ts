/**
 * The Worker entry point: an explicit method+path switch plus exported `InternalApi` RPC
 * (`WorkerEntrypoint`) and `LicenceMeter` (`DurableObject`).
 *
 * Endpoints
 * ─────────
 *   GET    /health                  liveness + configuration self-check (no secrets)
 *   POST   /api/provision-key       verify a Play purchase and mint/return a virtual key
 *   POST   /api/provision-free-token mint/rotate the device-bound Gestu Free virtual key
 *   POST   /api/provision-licence   verify a signed organisational licence and mint/return a key
 *   POST   /api/revoke-key          retire the presented key
 *   POST   /api/subscription-status plan, status, and this month's quota counter
 *   POST   /api/rtdn                Google Play Real-time Developer Notifications (Pub/Sub push)
 *   GET    /v1/models               the managed model ids, in OpenAI's list shape
 *   POST   /v1/chat/completions     the metered proxy (SSE passthrough), fee tier chosen by key
 *   OPTIONS (any)                   CORS preflight, answered only for allow-listed origins
 */

import { handleRevokeKey, handleRtdn, handleSubscriptionStatus } from "./api";
import { handleAdminBlock } from "./admin-block";
import { handleAdminExempt } from "./admin-exempt";
import { handleAdminUsage } from "./admin-usage";
import { handleAdminFunnel, hasFunnelDb } from "./funnel";
import type { Env } from "./config";
import {
  hasFreeUpstreamKey,
  hasImageGenKey,
  hasProUpstreamKey,
  readConfig,
  readAccessMeter,
  readFreeIpRateLimiter,
  readFreeRateLimiter,
  readLicencePublicKey,
  readServiceAccount,
} from "./config";
import {
  ADMIN_BLOCK_PATH,
  ADMIN_EXEMPT_PATH,
  ADMIN_FUNNEL_PATH,
  ADMIN_USAGE_PATH,
  CHAT_COMPLETIONS_PATH,
  FREE_PROVISION_PATH,
  HEALTH_PATH,
  IMAGES_GENERATIONS_PATH,
  MODELS_PATH,
  PROVISION_LICENCE_PATH,
  PROVISION_PATH,
  REVOKE_PATH,
  RTDN_PATH,
  STATUS_PATH,
} from "./constants";
import { handleProvisionFreeToken } from "./free";
import { InternalApi } from "./internal-api";
import { AccessMeter } from "./access-meter";
import { LicenceMeter } from "./licence-meter";
import { handleProvisionLicence } from "./licence-provision";
import { runScheduledPrune } from "./maintenance";
import { handleProvisionKey } from "./provision";
import { handleChatCompletions, handleImageGenerations, handleModels } from "./proxy";
import { corsHeaders, HttpError, jsonResponse } from "./responses";

export { AccessMeter, InternalApi, LicenceMeter };

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    // One clock reading per request: a request that straddles midnight UTC on the 1st must not
    // check the budget against one month and write usage against the next.
    const now = Date.now();
    const config = readConfig(env);
    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);
    const method = request.method.toUpperCase();
    const cors = corsHeaders(config.allowedOrigins, request.headers.get("origin"));

    if (method === "OPTIONS") return preflight(cors, request.headers.get("origin") ?? "");
    if (method === "HEAD") {
      const response = await route(request, env, pathname, method, cors, now, ctx);
      return new Response(null, { status: response.status, headers: response.headers });
    }

    try {
      return await route(request, env, pathname, method, cors, now, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(error.body, { status: error.status, headers: cors });
      }
      // An unexpected throw must still be a JSON answer: the app parses bodies, and an HTML error
      // page becomes a confusing parse failure on the client.
      console.error(
        `unhandled: ${request.method} ${pathname} — ${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }`,
      );
      return jsonResponse(
        { ok: false, error: "internal_error", message: "The server could not handle this request." },
        { status: 500, headers: cors },
      );
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      const report = await runScheduledPrune(env, readConfig(env));
      console.log(`scheduled: ${JSON.stringify(report)}`);
    } catch (error) {
      // A failed prune is not a user-visible failure; it retries tomorrow.
      console.error(
        `scheduled: prune failed — ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  },
} satisfies ExportedHandler<Env>;

/** Collapses a trailing slash so `/v1/chat/completions/` is not a 404. */
function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "") || "/";
  return pathname;
}

function preflight(cors: Record<string, string>, origin: string): Response {
  if (Object.keys(cors).length === 0) {
    // A preflight from an origin that is not allow-listed is answered with no CORS headers, which
    // is what makes the browser block the real request.
    return new Response(null, { status: origin === "" ? 204 : 403 });
  }
  return new Response(null, { status: 204, headers: cors });
}

async function route(
  request: Request,
  env: Env,
  pathname: string,
  method: string,
  cors: Record<string, string>,
  now: number,
  ctx?: ExecutionContext,
): Promise<Response> {
  const config = readConfig(env);
  switch (`${method} ${pathname}`) {
    case `GET ${HEALTH_PATH}`:
      return health(env);

    case `POST ${PROVISION_PATH}`:
      return withCors(await handleProvisionKey(request, env, config, now), cors);

    case `POST ${FREE_PROVISION_PATH}`:
      return withCors(await handleProvisionFreeToken(request, env, config, now), cors);

    case `POST ${PROVISION_LICENCE_PATH}`:
      return withCors(await handleProvisionLicence(request, env, config, now), cors);

    case `POST ${REVOKE_PATH}`:
      return withCors(await handleRevokeKey(request, env, now), cors);

    case `POST ${STATUS_PATH}`:
      return withCors(await handleSubscriptionStatus(request, env, config, now), cors);

    case `POST ${RTDN_PATH}`:
      // No CORS on the RTDN endpoint: it is Google's Pub/Sub that posts here, and a browser that
      // can reach it can forge subscription state changes.
      return handleRtdn(request, env, config, now);

    case `GET ${MODELS_PATH}`:
      return withCors(handleModels(env, config), cors);

    case `POST ${CHAT_COMPLETIONS_PATH}`:
      return withCors(await handleChatCompletions(request, env, config, now, ctx), cors);

    case `POST ${IMAGES_GENERATIONS_PATH}`:
      return withCors(await handleImageGenerations(request, env, config, now), cors);

    case `GET ${ADMIN_USAGE_PATH}`:
      // No CORS, and deliberately not wrapped in `withCors`: this is an operator endpoint for
      // curl and CI, never a browser origin, so it must not answer a preflight at all.
      return handleAdminUsage(request, env, now);

    case `GET ${ADMIN_FUNNEL_PATH}`:
      // Operator-only PII-free daily funnel counters. Same auth and no-CORS posture as /admin/usage.
      return handleAdminFunnel(request, env, now);

    case `GET ${ADMIN_EXEMPT_PATH}`:
    case `POST ${ADMIN_EXEMPT_PATH}`:
      // Operator-only, and likewise never wrapped in `withCors`: curl and CI, not browsers.
      return handleAdminExempt(request, env);

    case `GET ${ADMIN_BLOCK_PATH}`:
    case `POST ${ADMIN_BLOCK_PATH}`:
      // Ban list. Same credential and same no-CORS posture as the exemption route.
      return handleAdminBlock(request, env);

    default:
      break;
  }

  // A known path with the wrong method deserves a 405; an unknown path a 404. Both JSON.
  if (isKnownPath(pathname)) {
    return jsonResponse(
      { ok: false, error: "method_not_allowed", message: `${method} is not supported on ${pathname}` },
      { status: 405, headers: { ...cors, allow: allowedMethodsFor(pathname).join(", ") } },
    );
  }
  return jsonResponse(
    { ok: false, error: "not_found", message: `No route for ${method} ${pathname}` },
    { status: 404, headers: cors },
  );
}

function isKnownPath(pathname: string): boolean {
  return [
    HEALTH_PATH,
    PROVISION_PATH,
    FREE_PROVISION_PATH,
    PROVISION_LICENCE_PATH,
    REVOKE_PATH,
    STATUS_PATH,
    RTDN_PATH,
    MODELS_PATH,
    CHAT_COMPLETIONS_PATH,
    IMAGES_GENERATIONS_PATH,
    ADMIN_USAGE_PATH,
    ADMIN_FUNNEL_PATH,
    ADMIN_BLOCK_PATH,
  ADMIN_EXEMPT_PATH,
  ].includes(pathname);
}

function allowedMethodsFor(pathname: string): string[] {
  if (pathname === ADMIN_EXEMPT_PATH || pathname === ADMIN_BLOCK_PATH) return ["GET", "POST", "OPTIONS"];
  if (
    pathname === HEALTH_PATH ||
    pathname === MODELS_PATH ||
    pathname === ADMIN_USAGE_PATH ||
    pathname === ADMIN_FUNNEL_PATH
  ) {
    return ["GET", "OPTIONS"];
  }
  return ["POST", "OPTIONS"];
}

/** Adds the CORS headers to an already-built response without disturbing its body. */
function withCors(response: Response, cors: Record<string, string>): Response {
  if (Object.keys(cors).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function health(env: Env): Response {
  const config = readConfig(env);
  const serviceAccountConfigured = readServiceAccount(env, { quiet: true }) !== null;
  const proUpstreamConfigured = hasProUpstreamKey(env);
  const freeUpstreamConfigured = hasFreeUpstreamKey(env);
  const freeRateLimiterBound = readFreeRateLimiter(env) !== undefined;
  // The per-IP and Pro windows moved off KV onto their own bindings; a missing one silently falls
  // back to writing a KV counter per request, so report each rather than only the original.
  const freeIpRateLimiterBound = readFreeIpRateLimiter(env) !== undefined;
  // When absent, the day windows silently fall back to a KV counter per request — the cost the
  // object exists to remove — so report it rather than let it regress quietly.
  const accessMeterBound = Boolean(readAccessMeter(env));
  const packagesConfigured = config.allowedPackageNames.length > 0;
  const licenceKeyConfigured = readLicencePublicKey(env) !== "";
  const licenceMeterBound = Boolean(env.LICENCE_METER);

  const mode = serviceAccountConfigured && (licenceKeyConfigured || licenceMeterBound)
    ? "play+licence"
    : serviceAccountConfigured
      ? "play"
      : licenceKeyConfigured || licenceMeterBound
        ? "licence"
        : "unconfigured";

  // Both managed tiers are part of the launch: the Pro upstream is required, and the Free route is
  // required now that the app ships a Free model picker. A deployment missing either reports 503
  // loudly rather than serving half a product.
  const baseOk = proUpstreamConfigured && freeUpstreamConfigured && packagesConfigured;
  const modeOk = serviceAccountConfigured || licenceKeyConfigured || licenceMeterBound;

  const checks = {
    serviceAccount: serviceAccountConfigured,
    licenceKey: licenceKeyConfigured,
    licenceMeter: licenceMeterBound,
    proUpstreamKey: proUpstreamConfigured,
    freeUpstreamKey: freeUpstreamConfigured,
    imageGenKey: hasImageGenKey(env),
    freeRateLimiter: freeRateLimiterBound,
    freeIpRateLimiter: freeIpRateLimiterBound,
    accessMeter: accessMeterBound,
    allowedPackages: packagesConfigured,
    monthlyTokenLimit: config.monthlyTokenLimit > 0,
    deviceLimit: config.deviceLimit > 0,
    rtdnAuthenticated: config.rtdnAudience !== "",
  };
  return jsonResponse(
    {
      ok: baseOk && modeOk,
      service: "gestu-pro-proxy",
      mode,
      time: new Date().toISOString(),
      checks,
      productId: config.productId,
      basePlanId: config.basePlanId,
      monthlyTokenLimit: config.monthlyTokenLimit,
      freeMonthlyOutputTokenLimit: config.freeMonthlyOutputTokenLimit,
      deviceLimit: config.deviceLimit,
      proxyBaseUrl: config.proxyBaseUrl,
      freeProxyBaseUrl: config.proxyBaseUrl,
      funnelDbBound: hasFunnelDb(env),
      degraded: Object.entries(checks)
        .filter(([, value]) => !value)
        .map(([name]) => name),
    },
    { status: baseOk && modeOk ? 200 : 503 },
  );
}
