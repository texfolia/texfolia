import { expect, test } from "bun:test";

import { BillingError, markedUpNanos, nanoDollars, paidPlans } from "../src";

test("20% markup preserves fractional cents and rejects invalid costs", () => {
  expect(markedUpNanos(10_000_000)).toBe(12_000_000);
  expect(markedUpNanos(0)).toBe(0);
  expect(markedUpNanos(1)).toBe(2);
  expect(markedUpNanos(100, 0)).toBe(100);
  expect(() => markedUpNanos(-1)).toThrow();
  expect(() => markedUpNanos(Number.NaN)).toThrow();
  expect(() => markedUpNanos(1, 1.5)).toThrow();
  expect(() => markedUpNanos(Number.MAX_SAFE_INTEGER)).toThrow("precision");
});

test("a dollar is a billion nanodollars", () => {
  expect(nanoDollars).toBe(1_000_000_000);
});

test("billing errors carry an HTTP status", () => {
  const error = new BillingError("Upgrade", 403);
  expect(error).toBeInstanceOf(Error);
  expect(error.status).toBe(403);
  expect(error.message).toBe("Upgrade");
});

test("public plan data has no price IDs", () => {
  expect(paidPlans).toEqual({
    pro: { name: "Pro", monthlyUsd: 15 },
    team: { name: "Team", monthlyUsd: 20 },
  });
});
