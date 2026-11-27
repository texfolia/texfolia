import { expect, test } from "bun:test";

import { engineSchema, jobTimingSchema, unknownEngineTiming } from "../src";

test("reads the retired texlive engine as unknown", () => {
  expect(engineSchema.parse("texlive")).toBe("unknown");
  expect(engineSchema.parse("tectonic")).toBe("tectonic");
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
