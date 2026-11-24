import { describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { consumeFreeRateLimit } from "../src/free";
import { fakeKv } from "./fake-kv";

/**
 * The day window on the Durable Object path. The point of the object is that the counter is
 * single-writer *and* costs no KV write, so the assertion is both "it counts" and "KV was not
 * touched" — the second is the reason the object exists.
 */
function fakeAccessMeter(): DurableObjectNamespace {
  const buckets = new Map<string, { bucket: number; count: number }>();
  return {
    idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) => ({
      fetch: async (_url: string, init?: { body?: string }) => {
        const { windowMs, max, now } = JSON.parse(init?.body ?? "{}") as {
          windowMs: number;
          max: number;
          now: number;
        };
        const bucket = Math.floor(now / windowMs);
        const key = (id as unknown as { name: string }).name;
        const current = buckets.get(key);
        const count = current !== undefined && current.bucket === bucket ? current.count : 0;
        if (count >= max) {
          return new Response(JSON.stringify({ allowed: false, retryAfterSeconds: 42 }));
        }
        buckets.set(key, { bucket, count: count + 1 });
        return new Response(JSON.stringify({ allowed: true, retryAfterSeconds: 42 }));
      },
    }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    PRO_KV: fakeKv(),
    LICENCE_METER: {} as DurableObjectNamespace,
    GESTU_ALLOWED_PACKAGE_NAMES: "app.gestu.assistant",
    GESTU_PUBLIC_BASE_URL: "https://api.gestu.ca",
    ...overrides,
  } as Env;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("day window on the access meter", () => {
  it("counts in the object and leaves KV untouched", async () => {
    const env = makeEnv({ ACCESS_METER: fakeAccessMeter() });
    const input = {
      env,
      scope: "free-chat-day",
      identity: "device-1",
      max: 3,
      windowMs: DAY,
      now: NOW,
      dayMeter: env.ACCESS_METER,
    };

    for (let i = 0; i < 3; i += 1) {
      expect((await consumeFreeRateLimit(input)).allowed, `request ${i}`).toBe(true);
    }
    const fourth = await consumeFreeRateLimit(input);
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) expect(fourth.retryAfterSeconds).toBe(42);

    // The whole point: the limiter wrote nothing to KV.
    const kv = env.PRO_KV as unknown as { dump(): Map<string, string> };
    expect([...kv.dump().keys()].filter((key) => key.startsWith("rl:"))).toHaveLength(0);
  });

  it("falls back to the KV counter when no object is bound", async () => {
    const env = makeEnv();
    const first = await consumeFreeRateLimit({
      env,
      scope: "free-chat-day",
      identity: "device-2",
      max: 2,
      windowMs: DAY,
      now: NOW,
    });
    expect(first.allowed).toBe(true);
    const kv = env.PRO_KV as unknown as { dump(): Map<string, string> };
    expect([...kv.dump().keys()].some((key) => key.startsWith("rl:free-chat-day"))).toBe(true);
  });
});
