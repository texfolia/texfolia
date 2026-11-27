import { expect, test } from "bun:test";

import { jobTimingSchema } from "@texfolia/contracts";

import { parseEngineTiming } from "./telemetry";

const timing = {
  temperature: "cold",
  inputPrepMs: 1,
  compileMs: 2,
  outputMs: 3,
};

test("engine timing parses tectonic and falls back to unknown on invalid engine", () => {
  expect(
    parseEngineTiming(JSON.stringify({ ...timing, engine: "tectonic" })).engine,
  ).toBe("tectonic");
  expect(
    parseEngineTiming(JSON.stringify({ ...timing, engine: "unsupported" }))
      .engine,
  ).toBe("unknown");
});

test("job timing accepts tectonic and rejects unsupported engine names", () => {
  const base = {
    ...timing,
    plan: "free",
    attempt: 1,
    queueWaitMs: null,
    engineRequestMs: 0,
    publishMs: 0,
    backendMs: 0,
  };
  expect(
    jobTimingSchema.safeParse({ ...base, engine: "tectonic" }).success,
  ).toBe(true);
  expect(
    jobTimingSchema.safeParse({ ...base, engine: "unsupported" }).success,
  ).toBe(false);
});
