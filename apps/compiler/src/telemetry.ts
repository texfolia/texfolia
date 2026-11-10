import { z } from "zod";

const duration = z.number().finite().nonnegative();
export const planSchema = z.enum(["free", "pro", "unknown"]);
export const engineTimingSchema = z.object({
  engine: z.enum(["tectonic", "texlive", "unknown"]),
  temperature: z.enum(["cold", "warm", "unknown"]),
  inputPrepMs: duration.nullable(),
  compileMs: duration.nullable(),
  outputMs: duration.nullable(),
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
});
export type JobTiming = z.infer<typeof jobTimingSchema>;
export const previewTimingSchema = z.object({
  outcome: z.enum(["rendered", "preview_failed"]),
  submissionMs: duration,
  pollingMs: duration,
  downloadMs: duration,
  previewMs: duration,
  actionToPdfMs: duration,
  keystrokeToPdfMs: duration.nullable(),
});
export type PreviewTiming = z.infer<typeof previewTimingSchema>;

export function emitCompileEvent(
  event: {
    event:
      | "compile_submission"
      | "compile_engine_request"
      | "compile_retry"
      | "compile_backend";
    jobId: string;
  } & Record<string, unknown>,
) {
  console.info({ ...event, telemetryVersion: 1 });
}
