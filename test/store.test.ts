import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/base64";
import { STATUS } from "../src/constants";
import { isGrantActive } from "../src/quota";
import {
  bindDevice,
  deviceLimitFor,
  linkPurchaseTokenHash,
  newKeyRecord,
  purchaseTokenHash,
  quotaRecordKey,
  readQuota,
  recordUsage,
} from "../src/store";
import type { KeyRecord } from "../src/store";
import { fakeKv } from "./fake-kv";

function makeRecord(overrides: Partial<KeyRecord> = {}): KeyRecord {
  return {
    ...newKeyRecord({
      keyId: "keyid-1",
      packageName: "com.gestu.app",
      productId: "gestu_pro_monthly",
      obfuscatedAccountId: "obf-1",
      expiresAt: Date.UTC(2026, 9, 1),
      status: STATUS.ACTIVE,
      playState: "SUBSCRIPTION_STATE_ACTIVE",
      latestOrderId: "GPA.1",
      deviceId: "device-a",
      deviceLimit: 2,
      now: 1_000,
    }),
    ...overrides,
  };
}

describe("key record storage", () => {
  it("never stores the virtual key itself, only its hash", async () => {
    const kv = fakeKv();
    const virtualKey = "msk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const keyId = await sha256Hex(virtualKey);
    await kv.put(`key:${keyId}`, JSON.stringify(makeRecord({ keyId })));
    const serialized = JSON.stringify([...kv.dump().entries()]);
    expect(serialized).not.toContain(virtualKey);
    expect(serialized).toContain(keyId);
  });

  it("hashes purchase tokens so the KV keyspace holds no replayable credential", async () => {
    const tokenHash = await purchaseTokenHash("purchase-token-value");
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).toBe(await sha256Hex("purchase-token-value"));
    expect(tokenHash).not.toContain("purchase-token-value");
  });

  it("scopes a quota record to one key and one period", () => {
    expect(quotaRecordKey("abc", "2026-09")).toBe("quota:abc:2026-09");
    expect(quotaRecordKey("abc", "2026-10")).not.toBe(quotaRecordKey("abc", "2026-09"));
  });
});

describe("bindDevice with no cap", () => {
  it("keeps binding well past the deployment's limit", async () => {
    const kv = fakeKv();
    // Starts empty so the assertion is about what this test bound, not about the provisioning
    // device `newKeyRecord` puts on every record.
    let record = makeRecord({ deviceLimit: 0, devices: [] });
    for (const deviceId of ["d1", "d2", "d3", "d4", "d5"]) {
      const outcome = await bindDevice({ kv, record, deviceId, deviceLimit: 0, now: 2_000 });
      expect(outcome.kind).not.toBe("limit_reached");
      if (outcome.kind === "limit_reached") return;
      record = outcome.record;
    }
    expect(record.devices).toHaveLength(5);
  });

  it("still caps a key that declares a finite limit", async () => {
    const kv = fakeKv();
    const record = makeRecord({ deviceLimit: 1 });
    const outcome = await bindDevice({ kv, record, deviceId: "d2", deviceLimit: 1, now: 2_000 });
    expect(outcome.kind).toBe("limit_reached");
  });
});

describe("deviceLimitFor", () => {
  it("prefers the key's own cap over the deployment's", () => {
    expect(deviceLimitFor(makeRecord({ deviceLimit: 0 }), 2)).toBe(0);
    expect(deviceLimitFor(makeRecord({ deviceLimit: 25 }), 2)).toBe(25);
  });

  it("falls back to the configured limit for a record written before the field existed", () => {
    // This is the migration path for every Play subscription already in the field: those records
    // have no cap of their own and must keep taking `GESTU_DEVICE_LIMIT` rather than becoming
    // unlimited, which is what a `?? 0` would have done.
    const legacy = makeRecord();
    delete legacy.deviceLimit;
    expect(deviceLimitFor(legacy, 2)).toBe(2);
  });
});

describe("newKeyRecord", () => {
  it("starts with the provisioning device already bound and nothing revoked", () => {
    const record = makeRecord();
    expect(record.devices).toEqual([{ deviceId: "device-a", firstSeenAt: 1_000, lastSeenAt: 1_000 }]);
    expect(record.purchaseTokenHashes).toEqual([]);
    expect(record.revokedAt).toBe(0);
    expect(record.status).toBe(STATUS.ACTIVE);
  });
});

describe("linkPurchaseTokenHash", () => {
  it("adds a token once and is idempotent", () => {
    const record = makeRecord();
    const once = linkPurchaseTokenHash(record, "hash-1");
    expect(once.purchaseTokenHashes).toEqual(["hash-1"]);
    expect(linkPurchaseTokenHash(once, "hash-1").purchaseTokenHashes).toEqual(["hash-1"]);
    expect(linkPurchaseTokenHash(once, "hash-2").purchaseTokenHashes).toEqual(["hash-1", "hash-2"]);
  });

  it("keeps both tokens of an upgrade on the same key", () => {
    const upgraded = linkPurchaseTokenHash(linkPurchaseTokenHash(makeRecord(), "old"), "new");
    expect(upgraded.purchaseTokenHashes).toEqual(["old", "new"]);
  });
});

describe("bindDevice", () => {
  const setup = () => {
    const kv = fakeKv();
    const record = makeRecord();
    return { kv, record };
  };

  it("accepts a re-provision from the same device without consuming a slot", async () => {
    const { kv, record } = setup();
    const outcome = await bindDevice({ kv, record, deviceId: "device-a", deviceLimit: 2, now: 5_000 });
    expect(outcome.kind).toBe("same_device");
    if (outcome.kind === "limit_reached") throw new Error("unreachable");
    expect(outcome.record.devices).toHaveLength(1);
    expect(outcome.record.devices[0]?.lastSeenAt).toBe(5_000);
    // The persisted copy must agree with the returned one.
    expect(JSON.parse((await kv.get("key:keyid-1")) ?? "{}")).toMatchObject({ keyId: "keyid-1" });
  });

  it("allows a second device when the limit is two", async () => {
    const { kv, record } = setup();
    const outcome = await bindDevice({ kv, record, deviceId: "device-b", deviceLimit: 2, now: 6_000 });
    expect(outcome.kind).toBe("new_device");
    if (outcome.kind === "limit_reached") throw new Error("unreachable");
    expect(outcome.record.devices.map((device) => device.deviceId)).toEqual(["device-a", "device-b"]);
  });

  it("refuses a third device and leaves the record untouched", async () => {
    const { kv, record } = setup();
    const twoDevices: KeyRecord = {
      ...record,
      devices: [
        { deviceId: "device-a", firstSeenAt: 1, lastSeenAt: 1 },
        { deviceId: "device-b", firstSeenAt: 2, lastSeenAt: 2 },
      ],
    };
    const outcome = await bindDevice({ kv, record: twoDevices, deviceId: "device-c", deviceLimit: 2, now: 7_000 });
    expect(outcome).toEqual({ kind: "limit_reached", limit: 2 });
    expect(await kv.get("key:keyid-1")).toBeNull();
  });

  it("honours a limit of one", async () => {
    const { kv, record } = setup();
    const outcome = await bindDevice({ kv, record, deviceId: "device-b", deviceLimit: 1, now: 8_000 });
    expect(outcome.kind).toBe("limit_reached");
  });
});

describe("the entitlement gate the store feeds", () => {
  it("agrees with the app's own rule: active, grace, or canceled inside the paid period", () => {
    const now = Date.UTC(2026, 8, 15);
    expect(isGrantActive(STATUS.ACTIVE, Date.UTC(2026, 9, 1), now)).toBe(true);
    expect(isGrantActive(STATUS.GRACE, Date.UTC(2026, 9, 1), now)).toBe(true);
    // Play's CANCELED keeps access until the paid period ends — same rule as `isEntitledNow`.
    expect(isGrantActive(STATUS.CANCELED, Date.UTC(2026, 9, 1), now)).toBe(true);
    expect(isGrantActive(STATUS.CANCELED, Date.UTC(2026, 8, 1), now)).toBe(false);
  });
});

describe("quota recording and concurrent usage updates", () => {
  const NOW = Date.UTC(2026, 8, 15);
  const LIMIT = 100_000;

  it("returns zero usage on initial read", async () => {
    const kv = fakeKv();
    const quota = await readQuota(kv, "test-key-1", LIMIT, NOW);
    expect(quota.usedTokens).toBe(0);
    expect(quota.limitTokens).toBe(LIMIT);
    expect(quota.periodId).toBe("2026-09");
  });

  it("records usage and aggregates deltas", async () => {
    const kv = fakeKv();
    const res1 = await recordUsage(kv, "test-key-1", LIMIT, 500, 200, NOW);
    expect(res1.persisted).toBe(true);
    expect(res1.snapshot.usedTokens).toBe(700);

    const res2 = await recordUsage(kv, "test-key-1", LIMIT, 300, 100, NOW + 1000);
    expect(res2.persisted).toBe(true);
    expect(res2.snapshot.usedTokens).toBe(1100);

    const current = await readQuota(kv, "test-key-1", LIMIT, NOW + 2000);
    expect(current.usedTokens).toBe(1100);
  });

  it("handles parallel / concurrent usage updates without lost updates or race conditions", async () => {
    const kv = fakeKv();
    const keyId = "concurrent-key";
    const numRequests = 20;
    const tokensPerRequest = 500;

    // Launch all usage updates concurrently
    const promises = Array.from({ length: numRequests }, (_, i) =>
      recordUsage(kv, keyId, LIMIT, 250, 250, NOW + i * 10),
    );
    const results = await Promise.all(promises);

    expect(results).toHaveLength(numRequests);
    for (const r of results) {
      expect(r.persisted).toBe(true);
    }

    // Subsequent read must sum all concurrent request tokens without lost updates
    const finalQuota = await readQuota(kv, keyId, LIMIT, NOW + 5000);
    expect(finalQuota.usedTokens).toBe(numRequests * tokensPerRequest);
  });

  it("strictly enforces quota cap when concurrent usage accumulates past limit", async () => {
    const kv = fakeKv();
    const keyId = "cap-key";
    const smallLimit = 5_000;
    const numRequests = 10;
    const tokensPerRequest = 1_000;

    // 10 concurrent requests of 1000 tokens against a 5000 token limit
    const promises = Array.from({ length: numRequests }, (_, i) =>
      recordUsage(kv, keyId, smallLimit, tokensPerRequest / 2, tokensPerRequest / 2, NOW + i * 10),
    );
    await Promise.all(promises);

    const quota = await readQuota(kv, keyId, smallLimit, NOW + 2000);
    expect(quota.usedTokens).toBe(numRequests * tokensPerRequest);
    expect(quota.usedTokens >= quota.limitTokens).toBe(true);
  });

  it("prunes per-request usage delta keys when scheduled maintenance sweeps old periods", async () => {
    const kv = fakeKv();
    const keyId = "prune-test-key";
    const stalePeriod = "2026-06";
    const staleTime = Date.UTC(2026, 5, 15);
    const activeTime = Date.UTC(2026, 8, 15);

    // Record usage in a stale period
    await recordUsage(kv, keyId, LIMIT, 1000, 500, staleTime);
    expect((await readQuota(kv, keyId, LIMIT, staleTime)).usedTokens).toBe(1500);

    // Register in maintenance index
    const { rememberActiveKey } = await import("../src/store");
    const { runScheduledPrune } = await import("../src/maintenance");
    await rememberActiveKey(kv, keyId);

    // Run prune for active period
    const report = await runScheduledPrune(
      { PRO_KV: kv } as unknown as import("../src/config").Env,
      {} as unknown as import("../src/config").ProxyConfig,
      activeTime,
    );
    expect(report.ran).toBe(true);
    expect(report.periodsSwept).toContain(stalePeriod);

    // Usage deltas for stale period should be cleaned up
    const listResult = await kv.list({ prefix: `quota:usage:${keyId}:${stalePeriod}:` });
    expect(listResult.keys).toHaveLength(0);
  });
});
