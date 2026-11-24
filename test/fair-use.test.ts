import { describe, expect, it } from "vitest";
import type { Env } from "../src/config";
import { readConfig } from "../src/config";
import { DEFAULT_MONTHLY_TOKEN_LIMIT } from "../src/constants";

/**
 * The Pro plan's deploy-time backstop.
 *
 * The LOCKED product allowances are the two split caps in `src/constants.ts`
 * (1,500,000 output / 100,000,000 input per UTC month) enforced by `checkTierTokenCaps`. This file
 * pins the *operational seam* on top of them: `GESTU_MONTHLY_TOKEN_LIMIT` is a combined
 * prompt+completion ceiling that can be moved at deploy time without an app release, and a
 * malformed value falls back to the documented default rather than to unlimited.
 *
 * If someone later turns this into a permissive or a hard compiled-in tier, these tests are where
 * that shows up.
 */
function envWith(overrides: Partial<Env> = {}): Env {
  return { GESTU_ALLOWED_PACKAGE_NAMES: "com.gestu.app", ...overrides } as Env;
}

describe("monthly token ceiling is a deploy-time policy seam", () => {
  it("defaults to the documented fair-use backstop when unset", () => {
    expect(readConfig(envWith()).monthlyTokenLimit).toBe(DEFAULT_MONTHLY_TOKEN_LIMIT);
  });

  it("lets the operator raise the ceiling without an app release", () => {
    const raised = readConfig(envWith({ GESTU_MONTHLY_TOKEN_LIMIT: "500000000" }));
    expect(raised.monthlyTokenLimit).toBe(500_000_000);
    expect(raised.monthlyTokenLimit).toBeGreaterThan(DEFAULT_MONTHLY_TOKEN_LIMIT);
  });

  it("accepts a value below the default, so the operator can tighten it too", () => {
    expect(readConfig(envWith({ GESTU_MONTHLY_TOKEN_LIMIT: "1000000" })).monthlyTokenLimit).toBe(1_000_000);
  });

  it("falls back to the backstop rather than to unlimited on a malformed value", () => {
    // `readInt` refuses non-positive and non-numeric input. This matters: a typo that silently
    // became 0 would be read by `isExhausted` as "unlimited" and hand out an unbounded bill.
    for (const bad of ["0", "-1", "not-a-number", ""]) {
      const error = console.error;
      console.error = () => undefined;
      const config = readConfig(envWith({ GESTU_MONTHLY_TOKEN_LIMIT: bad }));
      console.error = error;
      expect(config.monthlyTokenLimit, `GESTU_MONTHLY_TOKEN_LIMIT=${JSON.stringify(bad)}`).toBe(
        DEFAULT_MONTHLY_TOKEN_LIMIT,
      );
    }
  });

  it("truncates a fractional value instead of carrying a fraction into the counter", () => {
    expect(readConfig(envWith({ GESTU_MONTHLY_TOKEN_LIMIT: "1500.9" })).monthlyTokenLimit).toBe(1500);
  });

  it("is generous enough to sit above the split tier caps it backs up", () => {
    // The combined backstop must not be the thing that cuts a user off before the locked
    // 1,500,000-output / 100,000,000-input caps do.
    expect(DEFAULT_MONTHLY_TOKEN_LIMIT).toBeGreaterThanOrEqual(101_500_000);
  });
});
