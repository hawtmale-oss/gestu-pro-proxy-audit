/**
 * Operator ban-list management.
 *
 * `POST /admin/block`  `{ deviceIds?: string[]; ips?: string[]; remove?: boolean }`
 * `GET  /admin/block?deviceId=<id>[&ip=<addr>]`
 *
 * Authorised with the operator master key (`GESTU_UNLIMITED_KEY`), the same credential
 * `/admin/exempt` uses. A banned device is refused at provisioning and on every inference request,
 * so it cannot re-provision a new key after a revocation.
 *
 * Entries live in `PRO_KV` under `blocked:device:<sha256>` and `blocked:ip:<addr>`, the keys
 * `src/blocked.ts` reads.
 */

import type { Env } from "./config";
import { blockedDeviceKey, blockedIpKey, isBlockedDevice, isBlockedIp } from "./blocked";
import { matchesOperatorKey } from "./exempt";
import { presentedKey } from "./provision";
import { sha256Hex } from "./base64";
import { HttpError, jsonResponse } from "./responses";

/** One call may ban this many ids of each kind; a paste of a whole fleet is a mistake. */
export const MAX_BLOCK_ENTRIES = 20;
const MAX_ID_LENGTH = 256;

interface BlockRequest {
  deviceIds: string[];
  ips: string[];
  remove: boolean;
}

export async function handleAdminBlock(request: Request, env: Env): Promise<Response> {
  if (!(await matchesOperatorKey(env, presentedKey(request)))) {
    return jsonResponse(
      { ok: false, error: "unauthorized", message: "Missing or invalid operator credential." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  if (request.method === "GET") return handleGet(request, env);

  let parsed: BlockRequest;
  try {
    parsed = parseBody(await request.json());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "bad_request", "Body must be a JSON object.");
  }

  const devices: { deviceId: string; hash: string }[] = [];
  for (const deviceId of parsed.deviceIds) {
    const hash = await sha256Hex(deviceId);
    const key = blockedDeviceKey(hash);
    if (parsed.remove) {
      await env.PRO_KV.delete(key);
    } else {
      await env.PRO_KV.put(key, "1");
    }
    devices.push({ deviceId, hash });
  }
  for (const ip of parsed.ips) {
    const key = blockedIpKey(ip);
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
        : "Entries stored. The ban applies immediately on this isolate and within 60s elsewhere.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** `?deviceId=…` / `?ip=…` answers the question the operator actually has: "is this one banned?" */
async function handleGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const deviceId = (url.searchParams.get("deviceId") ?? "").trim();
  const ip = (url.searchParams.get("ip") ?? "").trim();
  if (deviceId === "" && ip === "") {
    return jsonResponse(
      { ok: false, error: "bad_request", message: "Pass ?deviceId=<id> and/or ?ip=<addr>." },
      { status: 400 },
    );
  }
  return jsonResponse(
    {
      ok: true,
      device:
        deviceId === ""
          ? null
          : { deviceId, hash: await sha256Hex(deviceId), blocked: await isBlockedDevice(env, deviceId) },
      ip: ip === "" ? null : { ip, blocked: await isBlockedIp(env, ip) },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

function parseBody(raw: unknown): BlockRequest {
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
  if (value.length > MAX_BLOCK_ENTRIES) {
    throw new HttpError(400, "bad_request", `${field} accepts at most ${MAX_BLOCK_ENTRIES} entries per call.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > MAX_ID_LENGTH) {
      throw new HttpError(400, "bad_request", `${field} must contain non-empty strings of at most ${MAX_ID_LENGTH} characters.`);
    }
    return entry.trim();
  });
}
