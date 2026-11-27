import { expect, test } from "bun:test";

import { engineSchema, jobTimingSchema, unknownEngineTiming } from "../src";

test("accepts tectonic and unknown engines and rejects unsupported names", () => {
  expect(engineSchema.parse("tectonic")).toBe("tectonic");
  expect(engineSchema.parse("unknown")).toBe("unknown");
  expect(engineSchema.safeParse("texlive").success).toBe(false);
});

test("rejects timeline instants that are not ISO 8601", () => {
  const timing = {
    ...unknownEngineTiming,
    plan: "free",
    attempt: 1,
    queueWaitMs: null,
    engineRequestMs: 0,
    publishMs: 0,
    backendMs: 0,
  };
  expect(
    jobTimingSchema.safeParse({
      ...timing,
      startedAt: new Date().toISOString(),
    }).success,
  ).toBe(true);
  expect(
    jobTimingSchema.safeParse({ ...timing, startedAt: "yesterday" }).success,
  ).toBe(false);
});
