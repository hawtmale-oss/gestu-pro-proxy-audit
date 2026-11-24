/**
 * Banned devices and networks — the inverse of `exempt.ts`.
 *
 * An entry here means "this handle may never use the managed route again". It is checked before
 * anything is minted or metered, so a banned device cannot re-provision its way back in by
 * re-installing and asking for a new key — which is exactly what a plain `revokeKey` allows,
 * because the app answers a 401 by requesting a fresh key.
 *
 * Precedence: a ban beats an exemption. The two lists are read independently and the caller checks
 * this one first; an operator who has both a `blocked:` and an `exempt:` entry for the same device
 * meant to ban it, and an allow-list entry must never quietly undo that.
 *
 * A KV read that fails returns "not blocked". That is deliberate and the opposite of the rate
 * limiter's posture: a limiter that cannot answer must refuse, but a ban list that cannot answer
 * must not refuse the entire user base because one namespace call failed.
 */

import { sha256Hex } from "./base64";
import type { Env } from "./config";

export const BLOCKED_DEVICE_PREFIX = "blocked:device:";
export const BLOCKED_IP_PREFIX = "blocked:ip:";

/** KV key for one banned device hash. */
export function blockedDeviceKey(hash: string): string {
  return `${BLOCKED_DEVICE_PREFIX}${hash}`;
}

/** KV key for one banned address. */
export function blockedIpKey(ip: string): string {
  return `${BLOCKED_IP_PREFIX}${ip.trim().toLowerCase()}`;
}

/** True when `deviceId` is banned. Never throws. */
export async function isBlockedDevice(env: Env, deviceId: string | null | undefined): Promise<boolean> {
  if (deviceId === null || deviceId === undefined) return false;
  const id = deviceId.trim();
  if (id === "") return false;
  return blocked(env, blockedDeviceKey(await sha256Hex(id)));
}

/** True when the request's address is banned. Never throws. */
export async function isBlockedIp(env: Env, ip: string): Promise<boolean> {
  const address = ip.trim().toLowerCase();
  if (address === "") return false;
  return blocked(env, blockedIpKey(address));
}

/** True when either handle is banned. Checked before `isExemptRequest`. */
export async function isBlockedRequest(
  env: Env,
  deviceId: string | null | undefined,
  ip: string,
): Promise<boolean> {
  return (await isBlockedDevice(env, deviceId)) || (await isBlockedIp(env, ip));
}

/**
 * One KV read per key per isolate per minute.
 *
 * The list is tiny and changes rarely, and this runs on the hot path, so an uncached read per
 * request would put a KV round trip in front of every completion for a lookup that resolves the
 * same way hundreds of times a minute.
 */
async function blocked(env: Env, key: string): Promise<boolean> {
  const now = Date.now();
  const cached = blockCache.get(key);
  if (cached !== undefined && now - cached.at < BLOCK_CACHE_TTL_MS) return cached.hit;
  let hit = false;
  try {
    hit = (await env.PRO_KV.get(key)) !== null;
  } catch {
    // A ban list that cannot be read must not refuse the user base. Fail open, loudly.
    console.error(`blocked: could not read ${key} — treating as not banned`);
    hit = false;
  }
  if (blockCache.size >= BLOCK_CACHE_LIMIT) blockCache.clear();
  blockCache.set(key, { hit, at: now });
  return hit;
}

const BLOCK_CACHE_TTL_MS = 60_000;
const BLOCK_CACHE_LIMIT = 500;
const blockCache = new Map<string, { hit: boolean; at: number }>();

/**
 * Test hook: drop the cache so a ban written between two calls is visible immediately, instead of
 * waiting out the isolate's negative cache. Not used by production code.
 */
export function resetBlockCache(): void {
  blockCache.clear();
}
