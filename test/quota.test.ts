import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT,
  DEFAULT_MONTHLY_TOKEN_LIMIT,
  FREE_MAX_INPUT_TOKENS,
  FREE_MAX_REQUEST_TOKENS,
  FREE_MONTHLY_INPUT_TOKENS,
  FREE_MONTHLY_OUTPUT_TOKENS,
  FREE_MONTHLY_TOTAL_TOKENS,
  MAX_COMPLETION_TOKENS,
  PAID_MAX_INPUT_TOKENS,
  PAID_MAX_REQUEST_TOKENS,
  PRO_MONTHLY_INPUT_TOKENS,
  PRO_MONTHLY_OUTPUT_TOKENS,
  PRODUCT_ID_BUSINESS,
  PRODUCT_ID_FREE,
  PRODUCT_ID_PRO,
  STATUS,
  tierForProductId,
} from "../src/constants";
import {
  addUsage,
  checkTierTokenCaps,
  isExhausted,
  isGrantActive,
  maxCompletionTokensFor,
  maxInputTokensFor,
  maxRequestTokensFor,
  monthlyInputTokenLimitFor,
  monthlyOutputTokenLimitFor,
  monthsBetween,
  normalizeTokenCount,
  periodIdFor,
  periodRenewsAt,
  quotaSnapshot,
  readTierUsage,
  recordTierUsage,
  remainingTokens,
  requestCompletionCapFor,
  tierLabel,
  tokenLimitFor,
} from "../src/quota";
import { fakeKv } from "./fake-kv";

describe("tokenLimitFor", () => {
  const limits = {
    monthlyTokenLimit: DEFAULT_MONTHLY_TOKEN_LIMIT,
    businessMonthlyTokenLimit: DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT,
  };

  it("gives a business licence its own, much larger ceiling", () => {
    expect(tokenLimitFor(PRODUCT_ID_BUSINESS, limits)).toBe(DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT);
    expect(DEFAULT_BUSINESS_MONTHLY_TOKEN_LIMIT).toBeGreaterThan(DEFAULT_MONTHLY_TOKEN_LIMIT * 5);
  });

  it("gives a Free key the Free combined ceiling", () => {
    expect(tokenLimitFor(PRODUCT_ID_FREE, limits)).toBe(FREE_MONTHLY_TOTAL_TOKENS);
    expect(FREE_MONTHLY_TOTAL_TOKENS).toBe(FREE_MONTHLY_OUTPUT_TOKENS + FREE_MONTHLY_INPUT_TOKENS);
  });

  it("gives every other key the Pro deployment ceiling", () => {
    expect(tokenLimitFor(PRODUCT_ID_PRO, limits)).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
    // An unrecognised product id falls to the *Pro* ceiling, never the business one: guessing
    // generously about a product nobody recognises is how a metering bug becomes a bill.
    expect(tokenLimitFor("something-else", limits)).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
    expect(tokenLimitFor("", limits)).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
  });

  it("pins the locked Pro allowance as the combined default", () => {
    // LOCKED: Pro = 1,500,000 output + 100,000,000 input tokens/mo.
    expect(PRO_MONTHLY_OUTPUT_TOKENS).toBe(1_500_000);
    expect(PRO_MONTHLY_INPUT_TOKENS).toBe(100_000_000);
    expect(DEFAULT_MONTHLY_TOKEN_LIMIT).toBe(101_500_000);
  });
});

describe("periodIdFor", () => {
  it("is a zero-padded UTC calendar month", () => {
    expect(periodIdFor(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01");
    expect(periodIdFor(Date.UTC(2026, 8, 9, 23, 59, 59))).toBe("2026-09");
    expect(periodIdFor(Date.UTC(2026, 11, 31, 23, 59, 59, 999))).toBe("2026-12");
  });

  it("uses UTC, not the host's local month", () => {
    // 2026-01-01T00:00:00Z is still 2025-12-31 in every negative-offset timezone.
    const instant = Date.UTC(2026, 0, 1, 0, 30, 0);
    expect(periodIdFor(instant)).toBe("2026-01");
    // The last millisecond of a month belongs to that month, wherever the runtime is.
    expect(periodIdFor(Date.UTC(2025, 11, 31, 23, 59, 59, 999))).toBe("2025-12");
  });
});

describe("periodRenewsAt", () => {
  it("is the first millisecond of the next UTC month", () => {
    expect(periodRenewsAt(Date.UTC(2026, 8, 15, 12, 0, 0))).toBe(Date.UTC(2026, 9, 1, 0, 0, 0, 0));
  });

  it("rolls December into January of the next year", () => {
    expect(periodRenewsAt(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 1, 0, 0, 0, 0));
  });

  it("is strictly after the instant it was derived from", () => {
    const now = Date.UTC(2026, 1, 28, 6, 0, 0);
    expect(periodRenewsAt(now)).toBeGreaterThan(now);
  });
});

describe("monthsBetween", () => {
  it("counts whole months, signed", () => {
    expect(monthsBetween("2026-03", "2026-03")).toBe(0);
    expect(monthsBetween("2026-03", "2026-02")).toBe(1);
    expect(monthsBetween("2026-03", "2026-01")).toBe(2);
    expect(monthsBetween("2026-01", "2025-11")).toBe(2);
    expect(monthsBetween("2025-12", "2026-01")).toBe(-1);
    expect(monthsBetween("2027-01", "2026-12")).toBe(1);
  });

  it("returns null for malformed periods instead of guessing", () => {
    expect(monthsBetween("2026-3", "2026-02")).toBeNull();
    expect(monthsBetween("2026-13", "2026-02")).toBeNull();
    expect(monthsBetween("nonsense", "2026-02")).toBeNull();
  });
});

describe("normalizeTokenCount", () => {
  it("clamps anything that would poison the counter", () => {
    expect(normalizeTokenCount(10)).toBe(10);
    expect(normalizeTokenCount(10.9)).toBe(10);
    expect(normalizeTokenCount(0)).toBe(0);
    expect(normalizeTokenCount(-5)).toBe(0);
    expect(normalizeTokenCount(Number.NaN)).toBe(0);
    expect(normalizeTokenCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeTokenCount("120")).toBe(0);
    expect(normalizeTokenCount(null)).toBe(0);
    expect(normalizeTokenCount(undefined)).toBe(0);
  });
});

describe("quota accounting", () => {
  const base = quotaSnapshot({
    periodId: "2026-09",
    usedTokens: 0,
    limitTokens: DEFAULT_MONTHLY_TOKEN_LIMIT,
    renewsAt: Date.UTC(2026, 9, 1),
  });

  it("starts empty and unexhausted", () => {
    expect(base.usedTokens).toBe(0);
    expect(isExhausted(base)).toBe(false);
    expect(remainingTokens(base)).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
  });

  it("accumulates prompt + completion tokens", () => {
    const after = addUsage(base, 1_000, 250);
    expect(after.usedTokens).toBe(1_250);
    expect(after.periodId).toBe("2026-09");
    expect(remainingTokens(after)).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT - 1_250);
  });

  it("treats used == limit as exhausted, matching the app's own test", () => {
    const atLimit = quotaSnapshot({ ...base, usedTokens: DEFAULT_MONTHLY_TOKEN_LIMIT });
    expect(isExhausted(atLimit)).toBe(true);
    expect(remainingTokens(atLimit)).toBe(0);
  });

  it("treats a zero limit as unlimited rather than instantly exhausted", () => {
    // A misread var must not lock every subscriber out; the target check is `limit > 0 && used >= limit`.
    const unlimited = quotaSnapshot({ ...base, limitTokens: 0 });
    expect(isExhausted(unlimited)).toBe(false);
  });

  it("clamps a negative carried-over counter to zero", () => {
    expect(quotaSnapshot({ ...base, usedTokens: -100 }).usedTokens).toBe(0);
  });

  it("ignores a negative or NaN delta", () => {
    expect(addUsage(base, -1, -1).usedTokens).toBe(0);
    expect(addUsage(base, Number.NaN, 5).usedTokens).toBe(5);
  });
});

describe("isGrantActive", () => {
  const now = Date.UTC(2026, 8, 15);
  const future = now + 86_400_000;
  const past = now - 86_400_000;

  it("allows active, grace, and canceled-until-the-paid-period-ends", () => {
    expect(isGrantActive(STATUS.ACTIVE, future, now)).toBe(true);
    expect(isGrantActive(STATUS.GRACE, future, now)).toBe(true);
    // Play's CANCELED means "auto-renew off but the paid period has not ended yet"; refusing it
    // made a freshly provisioned key fail every request until it expired for good.
    expect(isGrantActive(STATUS.CANCELED, future, now)).toBe(true);
  });

  it("refuses on_hold, expired, revoked and none", () => {
    expect(isGrantActive(STATUS.ON_HOLD, future, now)).toBe(false);
    expect(isGrantActive(STATUS.EXPIRED, future, now)).toBe(false);
    expect(isGrantActive(STATUS.REVOKED, future, now)).toBe(false);
    expect(isGrantActive(STATUS.NONE, future, now)).toBe(false);
  });

  it("refuses an active grant whose paid period has ended", () => {
    expect(isGrantActive(STATUS.ACTIVE, past, now)).toBe(false);
    expect(isGrantActive(STATUS.GRACE, past, now)).toBe(false);
    expect(isGrantActive(STATUS.CANCELED, past, now)).toBe(false);
  });

  it("allows an active grant with no known expiry", () => {
    expect(isGrantActive(STATUS.ACTIVE, 0, now)).toBe(true);
  });

  it("refuses exactly at the expiry instant", () => {
    expect(isGrantActive(STATUS.ACTIVE, now, now)).toBe(false);
  });
});

describe("tier resolution and per-tier monthly caps", () => {
  it("resolves product IDs to free or pro tiers (failing closed to free)", () => {
    expect(tierForProductId(PRODUCT_ID_FREE)).toBe("free");
    expect(tierForProductId("free")).toBe("free");
    expect(tierForProductId("")).toBe("free");
    expect(tierForProductId(null)).toBe("free");
    expect(tierForProductId(undefined)).toBe("free");
    expect(tierForProductId("unknown-product")).toBe("free");

    expect(tierForProductId(PRODUCT_ID_PRO)).toBe("pro");
    expect(tierForProductId(PRODUCT_ID_BUSINESS)).toBe("pro");
    expect(tierForProductId("gestu_pro_licence")).toBe("pro");
    expect(tierForProductId("pro_yearly")).toBe("pro");

    // There is no Lite tier: the retired three-tier ids resolve to Free, never to Pro.
    expect(tierForProductId("gestu_lite_monthly")).toBe("free");
    expect(tierForProductId("gestu_lite_licence")).toBe("free");
    expect(tierForProductId("lite")).toBe("free");
  });

  it("returns the per-tier output, input, and request token limits", () => {
    expect(FREE_MONTHLY_OUTPUT_TOKENS).toBe(200_000);
    expect(monthlyOutputTokenLimitFor("free")).toBe(200_000);
    expect(monthlyOutputTokenLimitFor("pro")).toBe(1_500_000);
    expect(monthlyOutputTokenLimitFor(PRODUCT_ID_FREE)).toBe(200_000);
    expect(monthlyOutputTokenLimitFor(PRODUCT_ID_PRO)).toBe(1_500_000);

    expect(monthlyInputTokenLimitFor("free")).toBe(FREE_MONTHLY_INPUT_TOKENS);
    expect(monthlyInputTokenLimitFor("pro")).toBe(100_000_000);

    expect(maxRequestTokensFor("free")).toBe(FREE_MAX_REQUEST_TOKENS);
    expect(maxRequestTokensFor("pro")).toBe(PAID_MAX_REQUEST_TOKENS);

    expect(maxInputTokensFor("free")).toBe(FREE_MAX_INPUT_TOKENS);
    expect(maxInputTokensFor("pro")).toBe(PAID_MAX_INPUT_TOKENS);
    expect(PAID_MAX_INPUT_TOKENS).toBe(1_000_000);
    expect(PAID_MAX_REQUEST_TOKENS).toBe(1_000_000);
    expect(MAX_COMPLETION_TOKENS).toBe(384_000);

    expect(maxCompletionTokensFor("free")).toBeLessThan(maxCompletionTokensFor("pro"));
    expect(maxCompletionTokensFor("pro")).toBe(MAX_COMPLETION_TOKENS);
    expect(requestCompletionCapFor("pro", "reduced")).toBe(4_096);
    expect(requestCompletionCapFor("pro")).toBe(MAX_COMPLETION_TOKENS);
  });

  it("labels the tiers without ever naming an upstream provider", () => {
    expect(tierLabel("free")).toBe("Gestu Free");
    expect(tierLabel("pro")).toBe("Gestu Pro");
    for (const label of [tierLabel("free"), tierLabel("pro")]) {
      expect(label.toLowerCase()).not.toContain("deepseek");
      expect(label.toLowerCase()).not.toContain("gemini");
    }
  });

  it("enforces both monthly output billing caps and input cost-control caps", () => {
    // Free: 200,000 output / 15,000,000 input safety ceiling behind the $0.35 USD DO budget.
    expect(checkTierTokenCaps({ inputTokens: 100_000, outputTokens: 199_999 }, "free", "2026-11").allowed).toBe(true);
    const freeOut = checkTierTokenCaps({ inputTokens: 100_000, outputTokens: 200_000 }, "free", "2026-11");
    expect(freeOut.allowed).toBe(false);
    if (!freeOut.allowed) expect(freeOut.reason).toBe("output_cap_exceeded");

    const freeIn = checkTierTokenCaps({ inputTokens: 15_000_000, outputTokens: 1_000 }, "free", "2026-11");
    expect(freeIn.allowed).toBe(false);
    if (!freeIn.allowed) expect(freeIn.reason).toBe("input_cap_exceeded");

    // Pro: 1,500,000 output / 100,000,000 input.
    expect(checkTierTokenCaps({ inputTokens: 99_999_999, outputTokens: 1_499_999 }, "pro", "2026-11").allowed).toBe(true);
    expect(checkTierTokenCaps({ inputTokens: 1_000, outputTokens: 1_500_000 }, "pro", "2026-11").allowed).toBe(false);
    expect(checkTierTokenCaps({ inputTokens: 100_000_000, outputTokens: 1_000 }, "pro", "2026-11").allowed).toBe(false);

    // A message a customer reads never names the upstream provider.
    const refusal = checkTierTokenCaps({ inputTokens: 1_000, outputTokens: 200_000 }, "free", "2026-11");
    if (!refusal.allowed) {
      expect(refusal.message).toContain("Gestu Free");
      expect(refusal.message.toLowerCase()).not.toContain("deepseek");
      expect(refusal.message.toLowerCase()).not.toContain("gemini");
    }
  });

  it("tracks split input and output token usage concurrently in KV", async () => {
    const kv = fakeKv();
    const now = Date.UTC(2026, 10, 15);
    await Promise.all([
      recordTierUsage(kv, "key-a", 1_000, 200, now),
      recordTierUsage(kv, "key-a", 2_000, 300, now + 10),
    ]);
    const usage = await readTierUsage(kv, "key-a", now + 20);
    expect(usage.inputTokens).toBe(3_000);
    expect(usage.outputTokens).toBe(500);
  });
});
