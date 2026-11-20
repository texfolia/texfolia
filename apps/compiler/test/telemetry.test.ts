import { expect, test } from "bun:test";

import { jobTimingSchema } from "@texfolia/contracts";

import { parseEngineTiming } from "../src/telemetry";

const timing = {
  temperature: "cold",
  inputPrepMs: 1,
  compileMs: 2,
  outputMs: 3,
};

test("engine timing reads texlive as unknown", () => {
  expect(
    parseEngineTiming(JSON.stringify({ ...timing, engine: "texlive" })).engine,
  ).toBe("unknown");
  expect(
    parseEngineTiming(JSON.stringify({ ...timing, engine: "tectonic" })).engine,
  ).toBe("tectonic");
});

test("stored job timing with texlive still parses", () => {
  const parsed = jobTimingSchema.safeParse({
    ...timing,
    engine: "texlive",
    plan: "free",
    attempt: 1,
    artifactReused: false,
    queueWaitMs: null,
    inputReadMs: 0,
    engineRequestMs: 0,
    publishMs: 0,
    backendMs: 0,
  });
  expect(parsed.success && parsed.data.engine).toBe("unknown");
});
