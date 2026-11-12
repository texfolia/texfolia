import { createInterface } from "node:readline";

import { z } from "zod";

import { decodeTelemetry, previewTimingSchema } from "../src/telemetry";

const sampleSchema = previewTimingSchema.extend({
  event: z.literal("compile_preview"),
  telemetryVersion: z.literal(1),
  jobId: z.uuid(),
  plan: z.string().catch("unknown"),
  engine: z.string().catch("unknown"),
  temperature: z.string().catch("unknown"),
});
const tailSchema = z.object({
  logs: z.array(z.object({ message: z.array(z.unknown()) })),
});
const metrics = [
  "keystrokeToPdfMs",
  "actionToPdfMs",
  "submissionMs",
  "pollingMs",
  "downloadMs",
  "previewMs",
  "firstPdfByteMs",
] as const;

function* events(value: unknown): Generator<z.infer<typeof sampleSchema>> {
  if (typeof value === "string") {
    yield* events(decodeTelemetry(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* events(item);
    return;
  }
  const sample = sampleSchema.safeParse(value);
  if (sample.success) {
    yield sample.data;
    return;
  }
  const tail = tailSchema.safeParse(value);
  if (tail.success)
    for (const log of tail.data.logs)
      for (const message of log.message) yield* events(message);
}

export function summarizeCompileEvents(values: Iterable<unknown>) {
  const seen = new Set<string>();
  const groups = new Map<string, z.infer<typeof sampleSchema>[]>();
  for (const value of values)
    for (const sample of events(value)) {
      if (sample.outcome !== "rendered" || seen.has(sample.jobId)) continue;
      seen.add(sample.jobId);
      const key = JSON.stringify([
        sample.plan,
        sample.temperature,
        sample.engine,
      ]);
      const group = groups.get(key) ?? [];
      group.push(sample);
      groups.set(key, group);
    }
  return [...groups.values()].map((samples) => {
    const first = samples[0];
    if (!first) throw new Error("Empty sample group");
    return {
      plan: first.plan,
      temperature: first.temperature,
      engine: first.engine,
      jobs: samples.length,
      metrics: Object.fromEntries(
        metrics.map((metric) => {
          const values = samples
            .flatMap((sample) =>
              sample[metric] == null ? [] : [sample[metric]],
            )
            .sort((a, b) => a - b);
          return [
            metric,
            {
              samples: values.length,
              p50: values[Math.ceil(0.5 * values.length) - 1] ?? null,
              p95: values[Math.ceil(0.95 * values.length) - 1] ?? null,
            },
          ];
        }),
      ),
    };
  });
}

if (import.meta.main) {
  const values: unknown[] = [];
  let invalidLines = 0;
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      invalidLines++;
    }
  }
  console.info(
    JSON.stringify(
      { invalidLines, groups: summarizeCompileEvents(values) },
      null,
      2,
    ),
  );
}
