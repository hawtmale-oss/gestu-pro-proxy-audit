/**
 * Operator exemption management, so a device can be exempted without a redeploy.
 *
 * `POST /admin/exempt`  `{ deviceIds?: string[]; ips?: string[]; remove?: boolean }`
 * `GET  /admin/exempt?deviceId=<id>[&ip=<addr>]`
 *
 * Authorised with the operator master key (`GESTU_UNLIMITED_KEY`) — the same credential the
 * inference route already accepts, so there is no third secret to distribute. Compared as SHA-256
 * digests, never by string equality.
 *
 * The entries live in `PRO_KV` under `exempt:device:<sha256>` and `exempt:ip:<addr>`, the same keys
 * `src/exempt.ts` reads. Nothing here is client-facing: the response carries the ids the operator
 * just sent and their digests, and a request with a bad credential gets a flat 401 that does not
 * reveal whether the endpoint exists.
 */

import type { Env } from "./config";
import { deviceKey, ipKey, isExemptDevice, isExemptIp, matchesOperatorKey } from "./exempt";
import { presentedKey } from "./provision";
import { HttpError, jsonResponse } from "./responses";
import { sha256Hex } from "./base64";

/** One call may register this many ids of each kind; a paste of a whole fleet is a mistake. */
export const MAX_EXEMPT_ENTRIES = 20;
const MAX_ID_LENGTH = 256;

interface ExemptRequest {
  deviceIds: string[];
  ips: string[];
  remove: boolean;
}

export async function handleAdminExempt(request: Request, env: Env): Promise<Response> {
  if (!(await matchesOperatorKey(env, presentedKey(request)))) {
    return jsonResponse(
      { ok: false, error: "unauthorized", message: "Missing or invalid operator credential." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  if (request.method === "GET") return handleGet(request, env);

  let parsed: ExemptRequest;
  try {
    parsed = parseBody(await request.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "bad_request", "Body must be a JSON object.");
  }

  const devices: { deviceId: string; hash: string }[] = [];
  for (const deviceId of parsed.deviceIds) {
    const hash = await sha256Hex(deviceId);
    const key = deviceKey(hash);
    if (parsed.remove) {
      await env.PRO_KV.delete(key);
    } else {
      await env.PRO_KV.put(key, "1");
    }
    devices.push({ deviceId, hash });
  }
  for (const ip of parsed.ips) {
    const key = ipKey(ip);
    if (parsed.remove) {
      await env.PRO_KV.delete(key);
    } else {
      await env.PRO_KV.put(key, "1");
    }
  }

  return jsonResponse(
    {
      ok: true,
      removed: parsed.remove,
      devices,
      ips: parsed.ips,
      note: parsed.remove
        ? "Entries removed. A Worker isolate may keep answering from cache for up to 60s."
        : "Entries stored. Exemption applies immediately on this isolate and within 60s elsewhere.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** `?deviceId=…` / `?ip=…` answers the question the operator actually has: "is this one exempt?" */
async function handleGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  const ip = (url.searchParams.get("ip") ?? "").trim();
  if (deviceId === "" && ip === "") {
    return jsonResponse(
      {
        ok: false,
        error: "bad_request",
        message: "Pass ?deviceId=<id> and/or ?ip=<addr>.",
      },
      { status: 400 },
    );
  }
  return jsonResponse(
    {
      ok: true,
      device:
        deviceId === ""
          ? null
          : { deviceId, hash: await sha256Hex(deviceId), exempt: await isExemptDevice(env, deviceId) },
      ip: ip === "" ? null : { ip, exempt: await isExemptIp(env, ip) },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function parseBody(raw: unknown): ExemptRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "bad_request", "Body must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  return {
    deviceIds: readIds(record["deviceIds"], "deviceIds"),
    ips: readIds(record["ips"], "ips"),
    remove: record["remove"] === true,
  };
}

function readIds(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, "bad_request", `${field} must be an array of strings.`);
  }
  if (value.length > MAX_EXEMPT_ENTRIES) {
    throw new HttpError(400, "bad_request", `${field} accepts at most ${MAX_EXEMPT_ENTRIES} entries per call.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > MAX_ID_LENGTH) {
      throw new HttpError(400, "bad_request", `${field} must contain non-empty strings of at most ${MAX_ID_LENGTH} characters.`);
    }
    return entry.trim();
  });
}
