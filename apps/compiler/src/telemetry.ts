import { z } from "zod";

const duration = z.number().finite().nonnegative();
export const planSchema = z.enum(["free", "pro", "team", "unknown"]);
const engineTimingSchema = z.object({
  engine: z.enum(["tectonic", "texlive", "unknown"]),
  temperature: z.enum(["cold", "warm", "unknown"]),
  inputPrepMs: duration.nullable(),
  compileMs: duration.nullable(),
  outputMs: duration.nullable(),
  firstPdfByteMs: duration.nullable().optional(),
  cacheUsed: z.boolean().optional(),
  containerStartMs: duration.optional(),
  containerBootId: z.string().optional(),
  bootMs: duration.nullable().optional(),
  imageSizeBytes: z.number().int().nonnegative().nullable().optional(),
  archiveFetchMs: duration.optional(),
  archiveUnpackMs: duration.optional(),
  archiveBytes: z.number().int().nonnegative().optional(),
  archiveStatus: z
    .enum(["restored", "missing", "invalid", "warm", "unavailable"])
    .optional(),
  prewarmed: z.boolean().optional(),
});
export type EngineTiming = z.infer<typeof engineTimingSchema>;
export const unknownEngineTiming: EngineTiming = {
  engine: "unknown",
  temperature: "unknown",
  inputPrepMs: null,
  compileMs: null,
  outputMs: null,
};
export function decodeTelemetry(value: string | null | undefined): unknown {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return null;
  }
}

export function parseEngineTiming(
  value: string | null | undefined,
): EngineTiming {
  const parsed = engineTimingSchema.safeParse(decodeTelemetry(value));
  return parsed.success ? parsed.data : unknownEngineTiming;
}

export const jobTimingSchema = engineTimingSchema.extend({
  plan: planSchema,
  attempt: z.number().int().positive(),
  artifactReused: z.boolean(),
  queueWaitMs: duration.nullable(),
  inputReadMs: duration,
  engineRequestMs: duration,
  publishMs: duration,
  backendMs: duration,
  // Compiler-clock instants (ISO 8601) for the user-facing timeline. The
  // durations above remain the monotonic measurements.
  debounceMs: duration.optional(),
  delivery: z.enum(["direct", "overflow"]).optional(),
  startedAt: z.string().optional(),
  firstPdfAt: z.string().optional(),
  engineFinishedAt: z.string().optional(),
  publishedAt: z.string().optional(),
});
export const previewTimingSchema = z.object({
  outcome: z.enum(["rendered", "preview_failed"]),
  submissionMs: duration,
  pollingMs: duration,
  downloadMs: duration,
  previewMs: duration,
  actionToPdfMs: duration,
  keystrokeToPdfMs: duration.nullable(),
  firstPdfByteMs: duration.nullable().optional(),
});

export function emitCompileEvent(
  event: {
    event: "compile_pool_claim" | "compile_engine_request" | "compile_backend";
    jobId: string;
  } & Record<string, unknown>,
) {
  console.info({ ...event, telemetryVersion: 1 });
}
