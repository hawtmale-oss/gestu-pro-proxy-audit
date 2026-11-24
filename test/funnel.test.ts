import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config";
import { FREE_MANAGED_MODEL_ID, PRODUCT_ID_FREE, STATUS } from "../src/constants";
import {
  DAY7_ACTIVE_THRESHOLD_MS,
  FUNNEL_METRICS,
  handleAdminFunnel,
  queryFunnelStats,
  recordFunnelEvent,
  recordFunnelEventOnce,
} from "../src/funnel";
import { handleProvisionFreeToken } from "../src/free";
import { readConfig } from "../src/config";
import { handleChatCompletions } from "../src/proxy";
import { mintVirtualKey, sha256Hex } from "../src/base64";
import { newKeyRecord, putKeyRecord } from "../src/store";
import { recordTierUsage } from "../src/quota";
import { InternalApi } from "../src/internal-api";
import worker from "../src/index";
import { fakeKv } from "./fake-kv";

interface FakeD1Row {
  day: string;
  metric: string;
  count: number;
  updated_at: number;
}

/** Minimal in-memory D1Database supporting the exact SQL statements in `src/funnel.ts`. */
function createFakeFunnelDb(): D1Database & {
  rows: Map<string, FakeD1Row>;
  boundCalls: unknown[][];
} {
  const rows = new Map<string, FakeD1Row>();
  const boundCalls: unknown[][] = [];

  const db = {
    rows,
    boundCalls,
    prepare(query: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          args = values;
          boundCalls.push(values);
          return stmt;
        },
        async run() {
          if (/INSERT INTO funnel_daily_counters/i.test(query)) {
            const [day, metric, updatedAt] = args as [string, string, number];
            const key = `${day}|${metric}`;
            const existing = rows.get(key);
            if (existing) {
              existing.count += 1;
              existing.updated_at = updatedAt;
            } else {
              rows.set(key, { day, metric, count: 1, updated_at: updatedAt });
            }
          }
          return { success: true };
        },
        async all<T>() {
          if (/SELECT day, metric, count/i.test(query)) {
            const [from, to] = args as [string, string];
            const matching = [...rows.values()]
              .filter((r) => r.day >= from && r.day <= to)
              .sort((a, b) => a.day.localeCompare(b.day) || a.metric.localeCompare(b.metric));
            return { results: matching as unknown as T[], success: true };
          }
          return { results: [] as T[], success: true };
        },
      };
      return stmt;
    },
  };

  return db as unknown as D1Database & {
    rows: Map<string, FakeD1Row>;
    boundCalls: unknown[][];
  };
}

function makeEnv(funnelDb?: D1Database): Env {
  return {
    PRO_KV: fakeKv(),
    FUNNEL_DB: funnelDb,
    ADMIN_USAGE_SECRET: "funnel-admin-secret",
    GESTU_ALLOWED_PACKAGE_NAMES: "com.assistant.gestu,app.gestu.assistant",
    GESTU_PUBLIC_BASE_URL: "https://api.gestu.ca",
    UPSTREAM_API_KEY: "test-pro-key",
    DEEPSEEK_FREE_API_KEY: "test-free-key",
  };
}

describe("PII-free server-side funnel metrics (D1)", () => {
  const DAY1 = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01
  const DAY7 = DAY1 + DAY7_ACTIVE_THRESHOLD_MS + 60_000; // 2026-11-07
  const DAY8 = DAY1 + 7 * 86_400_000 + 60_000; // 2026-11-08 (past 7-day trial)

  it("includes a valid D1 SQL migration for funnel_daily_counters with zero PII columns", () => {
    const sql = readFileSync(
      resolve(process.cwd(), "migrations", "0001_funnel_metrics.sql"),
      "utf8",
    );
    const ddl = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS funnel_daily_counters");
    expect(sql).toContain("PRIMARY KEY (day, metric)");
    expect(ddl).not.toContain("user_id");
    expect(ddl).not.toContain("device_id");
    expect(ddl).not.toContain("email");
    expect(ddl).not.toContain("prompt");
  });

  it("is a safe no-op when FUNNEL_DB is unbound", async () => {
    const env = makeEnv(undefined);
    expect(await recordFunnelEvent(env, "trial_started", DAY1)).toBe(false);
    expect(await recordFunnelEventOnce(env, "trial_cap_hit", "meter-1", DAY1)).toBe(false);
    const stats = await queryFunnelStats(env, { from: "2026-11-01", to: "2026-11-30", now: DAY1 });
    expect(stats.days).toEqual([]);
    expect(stats.totals).toEqual({
      trial_started: 0,
      trial_cap_hit: 0,
      pro_activated: 0,
      day7_active: 0,
    });
  });

  it("records trial_started once per device and preserves the 7-day trial window across reinstalls", async () => {
    const db = createFakeFunnelDb();
    const env = makeEnv(db);
    const config = readConfig(env);

    const makeReq = () =>
      new Request("https://api.gestu.ca/api/provision-free-token", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.10" },
        body: JSON.stringify({
          deviceId: "dev-funnel-trial-1",
          packageName: "com.assistant.gestu",
          appVersion: "2.6.0",
        }),
      });

    const firstRes = await handleProvisionFreeToken(makeReq(), env, config, DAY1);
    const firstBody = (await firstRes.json()) as { ok: boolean; expiresAt: number };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.expiresAt).toBe(DAY1 + 7 * 86_400_000);

    // Reinstall on Day 3: must NOT reset the 7-day window and must NOT double-count trial_started.
    const secondRes = await handleProvisionFreeToken(makeReq(), env, config, DAY1 + 2 * 86_400_000);
    const secondBody = (await secondRes.json()) as { ok: boolean; expiresAt: number };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.expiresAt).toBe(firstBody.expiresAt);

    const stats = await queryFunnelStats(env, { from: "2026-11-01", to: "2026-11-10", now: DAY1 });
    expect(stats.totals.trial_started).toBe(1);

    // Verify zero PII or device IDs were ever bound to D1 SQL statements.
    const serializedBindings = JSON.stringify(db.boundCalls);
    expect(serializedBindings).not.toContain("dev-funnel-trial-1");
    expect(serializedBindings).not.toContain("198.51.100.10");
  });

  it("records trial_cap_hit once when a Free user hits cap or 7-day expiry, and day7_active on Day 7+", async () => {
    const db = createFakeFunnelDb();
    const env = makeEnv(db);
    const config = readConfig(env);

    // Provision Free key on Day 1.
    const provRes = await handleProvisionFreeToken(
      new Request("https://api.gestu.ca/api/provision-free-token", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.20" },
        body: JSON.stringify({
          deviceId: "dev-funnel-day7",
          packageName: "com.assistant.gestu",
          appVersion: "2.6.0",
        }),
      }),
      env,
      config,
      DAY1,
    );
    const { virtualKey } = (await provRes.json()) as { virtualKey: string };

    // Active on Day 7 (within the 7-day window): triggers day7_active once.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-day7",
          model: "deepseek-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "hello" } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const r1 = await handleChatCompletions(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${virtualKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": "198.51.100.20",
          },
          body: JSON.stringify({
            model: FREE_MANAGED_MODEL_ID,
            messages: [{ role: "user", content: "secret private prompt text" }],
          }),
        }),
        env,
        config,
        DAY7,
      );
      expect(r1.status).toBe(200);

      // Second request on Day 7 does NOT double-count day7_active.
      const r2 = await handleChatCompletions(
        new Request("https://api.gestu.ca/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${virtualKey}`,
            "content-type": "application/json",
            "cf-connecting-ip": "198.51.100.20",
          },
          body: JSON.stringify({
            model: FREE_MANAGED_MODEL_ID,
            messages: [{ role: "user", content: "another private prompt" }],
          }),
        }),
        env,
        config,
        DAY7 + 10_000,
      );
      expect(r2.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }

    // Day 8 (trial expired): returns 403 and counts trial_cap_hit once.
    const expired1 = await handleChatCompletions(
      new Request("https://api.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${virtualKey}`,
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.20",
        },
        body: JSON.stringify({
          model: FREE_MANAGED_MODEL_ID,
          messages: [{ role: "user", content: "after trial" }],
        }),
      }),
      env,
      config,
      DAY8,
    );
    expect(expired1.status).toBe(403);
    const expiredBody = (await expired1.json()) as { error: { message: string } };
    expect(expiredBody.error.message).toMatch(/7-day/i);

    // Retry on Day 8 must NOT double-count trial_cap_hit.
    const expired2 = await handleChatCompletions(
      new Request("https://api.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${virtualKey}`,
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.20",
        },
        body: JSON.stringify({
          model: FREE_MANAGED_MODEL_ID,
          messages: [{ role: "user", content: "retry after trial" }],
        }),
      }),
      env,
      config,
      DAY8 + 5_000,
    );
    expect(expired2.status).toBe(403);

    // Also verify KV quota cap hit increments trial_cap_hit for a separate capped Free device.
    const cappedKey = mintVirtualKey();
    const cappedKeyId = await sha256Hex(cappedKey);
    await putKeyRecord(env.PRO_KV, {
      ...newKeyRecord({
        keyId: cappedKeyId,
        packageName: "com.assistant.gestu",
        productId: PRODUCT_ID_FREE,
        obfuscatedAccountId: "",
        expiresAt: DAY1 + 7 * 86_400_000,
        status: STATUS.ACTIVE,
        playState: "",
        latestOrderId: "",
        deviceId: "dev-capped",
        deviceLimit: 1,
        now: DAY1,
      }),
      meterId: "free-device:capped",
      trialStartedAt: DAY1,
    });
    await recordTierUsage(env.PRO_KV, "free-device:capped", 1000, 200_000, DAY1);
    const cappedRes = await handleChatCompletions(
      new Request("https://api.gestu.ca/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${cappedKey}`,
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.21",
        },
        body: JSON.stringify({
          model: FREE_MANAGED_MODEL_ID,
          messages: [{ role: "user", content: "over cap" }],
        }),
      }),
      env,
      config,
      DAY1 + 60_000,
    );
    expect(cappedRes.status).toBe(429);

    const stats = await queryFunnelStats(env, { from: "2026-11-01", to: "2026-11-10", now: DAY8 });
    expect(stats.totals).toEqual({
      trial_started: 1,
      trial_cap_hit: 2,
      pro_activated: 0,
      day7_active: 1,
    });

    // Zero prompt content ever reaches D1.
    const serializedBindings = JSON.stringify(db.boundCalls);
    expect(serializedBindings).not.toContain("secret private prompt text");
    expect(serializedBindings).not.toContain("another private prompt");
  });

  it("records pro_activated once per Pro licence via InternalApi.upsertDevice", async () => {
    const db = createFakeFunnelDb();
    const env = makeEnv(db);
    const rpc = new InternalApi({} as ExecutionContext, env);

    await rpc.upsertDevice({
      licenceId: "lic_pro_1",
      deviceId: "dev-pro-a",
      keyId: await sha256Hex(mintVirtualKey()),
      status: "active",
      plan: "gestu_pro_monthly",
      periodEnd: DAY1 + 30 * 86_400_000,
      notAfter: DAY1 + 30 * 86_400_000,
      monthlyCapMicroUsd: 10_000_000,
      now: DAY1,
    });

    // Second device on the same Pro licence must NOT double-count pro_activated.
    await rpc.upsertDevice({
      licenceId: "lic_pro_1",
      deviceId: "dev-pro-b",
      keyId: await sha256Hex(mintVirtualKey()),
      status: "active",
      plan: "gestu_pro_monthly",
      periodEnd: DAY1 + 30 * 86_400_000,
      notAfter: DAY1 + 30 * 86_400_000,
      monthlyCapMicroUsd: 10_000_000,
      now: DAY1 + 1000,
    });

    const stats = await queryFunnelStats(env, { from: "2026-11-01", to: "2026-11-10", now: DAY1 });
    expect(stats.totals.pro_activated).toBe(1);
  });

  it("serves GET /admin/funnel in JSON and CSV with ADMIN_USAGE_SECRET auth and fails closed without it", async () => {
    const db = createFakeFunnelDb();
    const env = makeEnv(db);

    for (const metric of FUNNEL_METRICS) {
      await recordFunnelEvent(env, metric, DAY1);
    }
    await recordFunnelEvent(env, "trial_started", DAY7);

    // Unauthenticated -> 401
    const unauth = await worker.fetch(
      new Request("https://api.gestu.ca/admin/funnel?from=2026-11-01&to=2026-11-10"),
      env,
    );
    expect(unauth.status).toBe(401);

    // JSON report
    const jsonRes = await handleAdminFunnel(
      new Request("https://api.gestu.ca/admin/funnel?from=2026-11-01&to=2026-11-10", {
        headers: { authorization: "Bearer funnel-admin-secret" },
      }),
      env,
      DAY8,
    );
    expect(jsonRes.status).toBe(200);
    const jsonBody = (await jsonRes.json()) as {
      ok: boolean;
      totals: Record<string, number>;
      days: Array<{ day: string; trial_started: number }>;
    };
    expect(jsonBody.ok).toBe(true);
    expect(jsonBody.totals).toEqual({
      trial_started: 2,
      trial_cap_hit: 1,
      pro_activated: 1,
      day7_active: 1,
    });
    expect(jsonBody.days).toHaveLength(2);
    expect(jsonBody.days[0]?.day).toBe("2026-11-01");
    expect(jsonBody.days[1]?.day).toBe("2026-11-07");

    // CSV report
    const csvRes = await handleAdminFunnel(
      new Request("https://api.gestu.ca/admin/funnel?from=2026-11-01&to=2026-11-10&format=csv", {
        headers: { authorization: "Bearer funnel-admin-secret" },
      }),
      env,
      DAY8,
    );
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    expect(csvText).toBe(
      "day,trial_started,trial_cap_hit,pro_activated,day7_active\n" +
        "2026-11-01,1,1,1,1\n" +
        "2026-11-07,1,0,0,0\n",
    );

    // Missing FUNNEL_DB -> 503
    const noDbEnv = makeEnv(undefined);
    const noDbRes = await worker.fetch(
      new Request("https://api.gestu.ca/admin/funnel", {
        headers: { authorization: "Bearer funnel-admin-secret" },
      }),
      noDbEnv,
    );
    expect(noDbRes.status).toBe(503);
  });
});
