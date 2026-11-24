import { describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import {
  constantTimeEqual,
  handleAdminUsage,
  kindForMeter,
  listMetersForPeriod,
  toCsv,
  verifyAdminUsageSecret,
} from "../src/admin-usage";
import { HttpError } from "../src/responses";
import { fakeKv } from "./fake-kv";

const SECRET = "usage_admin_secret_for_tests";
const PERIOD = "2026-11";

/** A `Env` with only what the admin report touches. No LICENCE_METER, so enrichment is skipped. */
function envWith(kv: KVNamespace, secret: string | null = SECRET): Env {
  // `null` means "field absent". Passing `undefined` would silently hit the default parameter,
  // which is exactly the mistake the unset-secret test needs to avoid.
  return {
    PRO_KV: kv,
    ...(secret === null ? {} : { ADMIN_USAGE_SECRET: secret }),
  } as unknown as Env;
}

function request(path: string, token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(`https://api.gestu.ca${path}`, { headers });
}

async function seedTier(kv: KVNamespace, meterId: string, period: string, input: number, output: number) {
  await kv.put(
    `quota:tier:${meterId}:${period}`,
    JSON.stringify({ periodId: period, inputTokens: input, outputTokens: output }),
  );
}

describe("constantTimeEqual", () => {
  it("accepts identical strings and rejects a single differing character", async () => {
    expect(await constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(await constantTimeEqual("abc124", "abc123")).toBe(false);
  });

  it("rejects a prefix of the expected value", async () => {
    expect(await constantTimeEqual("abc12", "abc123")).toBe(false);
  });
});

describe("verifyAdminUsageSecret", () => {
  it("fails closed with 503 when ADMIN_USAGE_SECRET is not configured", async () => {
    const error = await verifyAdminUsageSecret(request("/admin/usage", "anything"), envWith(fakeKv(), null)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
  });

  it("rejects a missing or wrong bearer credential with 401", async () => {
    const noHeader = await verifyAdminUsageSecret(request("/admin/usage"), envWith(fakeKv())).catch(
      (caught: unknown) => caught,
    );
    expect((noHeader as HttpError).status).toBe(401);

    const wrong = await verifyAdminUsageSecret(request("/admin/usage", "nope"), envWith(fakeKv())).catch(
      (caught: unknown) => caught,
    );
    expect((wrong as HttpError).status).toBe(401);
  });

  it("accepts the configured secret", async () => {
    await expect(verifyAdminUsageSecret(request("/admin/usage", SECRET), envWith(fakeKv()))).resolves.toBeUndefined();
  });
});

describe("listMetersForPeriod", () => {
  it("returns only the requested period, so a rollover does not leak last month in", async () => {
    const kv = fakeKv();
    await seedTier(kv, "free-device:aaa", PERIOD, 1, 2);
    await seedTier(kv, "free-device:bbb", "2026-10", 3, 4);

    const { meterIds, truncated } = await listMetersForPeriod(kv, PERIOD);
    expect(meterIds).toEqual(["free-device:aaa"]);
    expect(truncated).toBe(false);
  });

  it("keeps metre ids that themselves contain a colon", async () => {
    const kv = fakeKv();
    await seedTier(kv, "free-device:deadbeef", PERIOD, 5, 5);
    const { meterIds } = await listMetersForPeriod(kv, PERIOD);
    expect(meterIds).toEqual(["free-device:deadbeef"]);
  });
});

describe("handleAdminUsage", () => {
  it("sums per-meter counters and sorts the heaviest consumer first", async () => {
    const kv = fakeKv();
    await seedTier(kv, "free-device:small", PERIOD, 1, 2);
    await seedTier(kv, "free-device:large", PERIOD, 10, 20);

    const response = await handleAdminUsage(request(`/admin/usage?period=${PERIOD}`, SECRET), envWith(kv), Date.now());
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      meterCount: number;
      durableObjectAvailable: boolean;
      totals: { inputTokens: number; outputTokens: number; totalTokens: number };
      rows: Array<{ meterId: string; kind: string; totalTokens: number; usedMicroUsd: number | null }>;
    };

    expect(body.meterCount).toBe(2);
    expect(body.durableObjectAvailable).toBe(false);
    const [heaviest, lightest] = body.rows;
    expect(heaviest?.meterId).toBe("free-device:large");
    expect(heaviest?.totalTokens).toBe(30);
    expect(heaviest?.kind).toBe("free");
    expect(lightest?.meterId).toBe("free-device:small");
    // No Durable Object bound: cost is unknown rather than a misleading zero.
    expect(heaviest?.usedMicroUsd).toBeNull();
    expect(body.totals).toMatchObject({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it("selects a single meter with ?meter=", async () => {
    const kv = fakeKv();
    await seedTier(kv, "free-device:one", PERIOD, 4, 4);
    await seedTier(kv, "free-device:two", PERIOD, 9, 9);

    const response = await handleAdminUsage(
      request(`/admin/usage?period=${PERIOD}&meter=free-device:one`, SECRET),
      envWith(kv),
      Date.now(),
    );
    const body = (await response.json()) as { meterCount: number; rows: Array<{ meterId: string }> };
    expect(body.meterCount).toBe(1);
    expect(body.rows[0]?.meterId).toBe("free-device:one");
  });

  it("tolerates a corrupt counter instead of failing the whole report", async () => {
    const kv = fakeKv();
    await kv.put(`quota:tier:free-device:broken:${PERIOD}`, "{not json");
    await seedTier(kv, "free-device:fine", PERIOD, 2, 3);

    const response = await handleAdminUsage(request(`/admin/usage?period=${PERIOD}`, SECRET), envWith(kv), Date.now());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<{ meterId: string; totalTokens: number }> };
    const broken = body.rows.find((row) => row.meterId === "free-device:broken");
    expect(broken?.totalTokens).toBe(0);
  });

  it("serves CSV with an attachment disposition", async () => {
    const kv = fakeKv();
    await seedTier(kv, "free-device:csv", PERIOD, 7, 8);

    const response = await handleAdminUsage(
      request(`/admin/usage?period=${PERIOD}&format=csv`, SECRET),
      envWith(kv),
      Date.now(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(`gestu-usage-${PERIOD}.csv`);

    const text = await response.text();
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe(
      "meter_id,kind,period_id,input_tokens,output_tokens,total_tokens,used_micro_usd,request_count,mode,tier",
    );
    expect(lines[1]).toContain("free-device:csv");
    expect(lines[1]).toContain(",free,2026-11,7,8,15,");
  });

  it("rejects a malformed period and an unknown format with 400", async () => {
    const kv = fakeKv();
    const badPeriod = await handleAdminUsage(request("/admin/usage?period=2026-13", SECRET), envWith(kv), Date.now()).catch(
      (caught: unknown) => caught,
    );
    expect((badPeriod as HttpError).status).toBe(400);

    const badFormat = await handleAdminUsage(
      request(`/admin/usage?period=${PERIOD}&format=xml`, SECRET),
      envWith(kv),
      Date.now(),
    ).catch((caught: unknown) => caught);
    expect((badFormat as HttpError).status).toBe(400);
  });

  it("does not reach the report without the secret", async () => {
    const kv = fakeKv();
    await seedTier(kv, "free-device:x", PERIOD, 1, 1);
    const error = await handleAdminUsage(request(`/admin/usage?period=${PERIOD}`, "wrong"), envWith(kv), Date.now()).catch(
      (caught: unknown) => caught,
    );
    expect((error as HttpError).status).toBe(401);
  });
});

describe("kindForMeter", () => {
  it("classifies by key prefix so the label never depends on Durable Object state", () => {
    expect(kindForMeter("free-device:abc123")).toBe("free");
    expect(kindForMeter("lic_01HXYZ")).toBe("licence");
    expect(kindForMeter("key:deadbeef")).toBe("other");
  });
});

describe("toCsv", () => {
  it("quotes a meter id containing a comma", () => {
    const csv = toCsv([
      {
        meterId: "odd,id",
        kind: "other",
        periodId: PERIOD,
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        usedMicroUsd: null,
        usedPpm: null,
        limitPpm: null,
        requestCount: null,
        mode: null,
        tier: null,
      },
    ]);
    expect(csv).toContain('"odd,id"');
  });

  it("ends with a newline so appends do not concatenate rows", () => {
    expect(toCsv([]).endsWith("\n")).toBe(true);
  });
});
