import { expect, test } from "bun:test";

import { summarizeCompileEvents } from "../scripts/compile-percentiles";

test("percentiles split cohorts, deduplicate jobs, and exclude failed or absent renders", () => {
  const sample = (ms: number) => ({
    event: "compile_preview",
    telemetryVersion: 1,
    jobId: crypto.randomUUID(),
    plan: "pro",
    engine: "tectonic",
    temperature: "warm",
    outcome: "rendered",
    submissionMs: 5,
    pollingMs: 10,
    downloadMs: 5,
    previewMs: 5,
    actionToPdfMs: 25,
    keystrokeToPdfMs: ms,
  });
  const samples = Array.from({ length: 20 }, (_, i) => sample(i + 1));
  const result = summarizeCompileEvents([
    ...samples,
    samples[0],
    {
      logs: [
        { message: [JSON.stringify({ ...sample(100), temperature: "cold" })] },
      ],
    },
    { ...sample(1000), outcome: "preview_failed" },
    { ...sample(0), keystrokeToPdfMs: null },
    { event: "compile_backend" },
  ]);
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({
    plan: "pro",
    temperature: "warm",
    jobs: 21,
    metrics: {
      keystrokeToPdfMs: { samples: 20, p50: 10, p95: 19 },
      actionToPdfMs: { samples: 21, p50: 25, p95: 25 },
    },
  });
  expect(result[1]).toMatchObject({
    temperature: "cold",
    jobs: 1,
    metrics: { keystrokeToPdfMs: { p50: 100, p95: 100 } },
  });
});
