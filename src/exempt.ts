/**
 * Operator exemptions — the owner's own devices, and the networks they test from.
 *
 * A short, explicit allow list is the difference between "our own phone always works" and
 * "raise a production anti-abuse cap for everybody". Nothing here is inferred: an entry exists
 * only because an operator typed it into a secret. An empty list changes nothing at all.
 *
 * Two handles, because they answer different questions:
 *
 *  - **Device hashes** (`GESTU_UNLIMITED_DEVICE_HASHES`) — the precise one. The app presents a
 *    random 128-bit `deviceId` and the same value identifies it in every limit: the Free
 *    per-IP new-device cap, the Free meter, and the key record. Store only `sha256(deviceId)`,
 *    lowercase hex, comma-separated. The raw id never needs to sit in a deployment.
 *  - **IPs** (`GESTU_UNLIMITED_IPS`) — the blunt one, for the case where the device id cannot be
 *    read (the app does not show it yet). It exempts everything behind that address, so it is a
 *    testing aid, not a substitute for the hash.
 *
 * Both are read from secrets rather than `[vars]`: `wrangler secret put`, never the committed
 * TOML. A public `[vars]` entry would publish the deployment's own home address.
 *
 * Exemption is *not* authentication. A device id is client-asserted, so this list is only as
 * private as the hash list is; a 128-bit random id cannot be guessed from its hash, which is the
 * whole reason the list stores hashes and not ids.
 */

import { sha256Hex } from "./base64";
import type { Env } from "./config";

export const UNLIMITED_DEVICE_HASHES_ENV = "GESTU_UNLIMITED_DEVICE_HASHES";
export const UNLIMITED_IPS_ENV = "GESTU_UNLIMITED_IPS";
export const UNLIMITED_KEY_ENV = "GESTU_UNLIMITED_KEY";

/**
 * True when the presented bearer credential is one of the operator master keys.
 *
 * A comma-separated list, so a developer can hold their own credential and have it revoked by
 * replacing the secret without disturbing the owner's. This is the one credential that needs no
 * key record: it authenticates straight into the proxy with every limit switched off, which is
 * what makes it usable from a stock client that has not been (and may never be) re-provisioned.
 *
 * Compared as SHA-256 digests, so a wrong key leaks neither its length nor its prefix, and every
 * candidate is checked even after a match so the loop does not reveal which entry matched.
 */
export async function matchesOperatorKey(env: Env, presented: string): Promise<boolean> {
  const configured = (env as unknown as Record<string, string | undefined>)[UNLIMITED_KEY_ENV];
  if (typeof configured !== "string" || presented === "") return false;
  const candidates = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (candidates.length === 0) return false;
  const got = await sha256Hex(presented);
  let matched = false;
  for (const candidate of candidates) {
    const want = await sha256Hex(candidate);
    if (constantTimeEqual(got, want)) matched = true;
  }
  return matched;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/** The `sha256(deviceId)` values, lowercase hex. Empty when unset. */
export function unlimitedDeviceHashes(env: Env): ReadonlySet<string> {
  return readSet(env, UNLIMITED_DEVICE_HASHES_ENV);
}

/** The exempt addresses, as Cloudflare reports them in `CF-Connecting-IP`. Empty when unset. */
export function unlimitedIps(env: Env): ReadonlySet<string> {
  return readSet(env, UNLIMITED_IPS_ENV);
}

/**
 * True when `deviceId` belongs to an exempt device.
 *
 * Two sources, checked in this order: the deployment secret (cheap, no I/O) and the KV entry that
 * `POST /admin/exempt` writes (so a device can be exempted without a redeploy). Hashing is skipped
 * entirely when neither is configured.
 */
export async function isExemptDevice(env: Env, deviceId: string | null | undefined): Promise<boolean> {
  if (deviceId === null || deviceId === undefined) return false;
  const id = deviceId.trim();
  if (id === "") return false;
  const hash = await sha256Hex(id);
  if (unlimitedDeviceHashes(env).has(hash)) return true;
  return kvExempt(env, deviceKey(hash));
}

/** True when the request's address is exempt, by secret or by the KV entry the admin route writes. */
export async function isExemptIp(env: Env, ip: string): Promise<boolean> {
  const address = ip.trim().toLowerCase();
  if (address === "") return false;
  if (unlimitedIps(env).has(address)) return true;
  return kvExempt(env, ipKey(address));
}

/** KV key for one exempt device hash. */
export function deviceKey(hash: string): string {
  return `exempt:device:${hash}`;
}

/** KV key for one exempt address. */
export function ipKey(ip: string): string {
  return `exempt:ip:${ip.trim().toLowerCase()}`;
}

/**
 * One KV read per key per isolate per minute.
 *
 * The admin route is rare and the check runs on every completion, so an unbounded read per request
 * would put a KV round trip in front of the whole managed route for a list that changes once a
 * week. A miss is cached too: exemption is not a thing that appears between two requests of the
 * same minute in a way anyone would notice.
 */
async function kvExempt(env: Env, key: string): Promise<boolean> {
  const now = Date.now();
  const cached = exemptionCache.get(key);
  if (cached !== undefined && now - cached.at < EXEMPTION_CACHE_TTL_MS) return cached.hit;
  let hit = false;
  try {
    hit = (await env.PRO_KV.get(key)) !== null;
  } catch {
    // A KV outage must not grant an exemption: fail to "not exempt".
    hit = false;
  }
  if (exemptionCache.size >= EXEMPTION_CACHE_LIMIT) exemptionCache.clear();
  exemptionCache.set(key, { hit, at: now });
  return hit;
}

const EXEMPTION_CACHE_TTL_MS = 60_000;
const EXEMPTION_CACHE_LIMIT = 500;
const exemptionCache = new Map<string, { hit: boolean; at: number }>();

/** True when either list would matter for this request. Used to keep the hot path cheap. */
export async function isExemptRequest(env: Env, deviceId: string | null | undefined, ip: string): Promise<boolean> {
  return (await isExemptIp(env, ip)) || (await isExemptDevice(env, deviceId));
}

function readSet(env: Env, name: string): ReadonlySet<string> {
  const raw = (env as unknown as Record<string, string | undefined>)[name];
  if (typeof raw !== "string" || raw.trim() === "") return EMPTY;
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  return parsed.length === 0 ? EMPTY : new Set(parsed);
}

const EMPTY: ReadonlySet<string> = new Set<string>();
