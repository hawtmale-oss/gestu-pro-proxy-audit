/**
 * `AccessMeter` — one Durable Object per (scope, identity) that owns a *day* counter.
 *
 * The day windows are the last thing on the Free path that had to write KV: a `ratelimit` binding
 * can only express 10- or 60-second periods, so a 24-hour window needs real state. KV worked, but
 * it spends the account's daily write allowance on every request — and on the free plan that
 * allowance, not the policy, is what actually bounds the product.
 *
 * One object per `(scope, identity)` keeps the counter single-writer and strongly consistent, which
 * a KV read-modify-write cannot be. The object is cheap: it holds a handful of integers and prunes
 * its own old buckets, so storage stays O(1) per identity.
 *
 * Named via `env.ACCESS_METER.idFromName(`${scope}:${identity}`)`.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./config";

/** The day-counter request body. `windowMs` is the window length; `max` the ceiling. */
export interface HitDayInput {
  windowMs: number;
  max: number;
  now: number;
}

export interface HitDayResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class AccessMeter extends DurableObject<Env> {
  /** Increments the current window's counter and answers whether the request is allowed. */
  async hitDay(input: HitDayInput): Promise<HitDayResult> {
    const bucket = Math.floor(input.now / input.windowMs);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((bucket + 1) * input.windowMs - input.now) / 1000),
    );
    const key = `bucket:${bucket}`;
    const used = (await this.ctx.storage.get<number>(key)) ?? 0;
    if (used >= input.max) {
      return { allowed: false, retryAfterSeconds };
    }
    await this.ctx.storage.put(key, used + 1);
    // Keep the current bucket and the previous one (a clock skew or a rollover edge can still read
    // it); anything older is dead weight for a window that is already over.
    if (used === 0) {
      await this.ctx.storage.delete(`bucket:${bucket - 2}`);
    }
    return { allowed: true, retryAfterSeconds };
  }

  /** Reads the current window's count without incrementing. Operator/debug use. */
  async readDay(input: { windowMs: number; now: number }): Promise<{ used: number }> {
    const bucket = Math.floor(input.now / input.windowMs);
    return { used: (await this.ctx.storage.get<number>(`bucket:${bucket}`)) ?? 0 };
  }
}
