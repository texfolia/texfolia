import { z } from "zod";

export const durationSchema = z.number().finite().nonnegative();
const duration = durationSchema;
const instant = z.iso.datetime({ offset: true });

export const planSchema = z.enum(["free", "pro", "team", "unknown"]);
export type Plan = z.infer<typeof planSchema>;
// Only Tectonic is installed. Older records may still say "texlive"; read
// those as "unknown" so nothing can report TeX Live as the engine.
export const engineSchema = z.preprocess(
  (value) => (value === "texlive" ? "unknown" : value),
  z.enum(["tectonic", "unknown"]),
);
export const temperatureSchema = z.enum(["cold", "warm", "unknown"]);
export const archiveStatusSchema = z.enum([
  "restored",
  "missing",
  "invalid",
  "warm",
  "unavailable",
]);
export const deliverySchema = z.enum(["direct", "overflow"]);

// Reported by the TeX host for one engine request.
export const engineTimingSchema = z.object({
  engine: engineSchema,
  temperature: temperatureSchema,
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
  archiveStatus: archiveStatusSchema.optional(),
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

// Recorded by the compiler on each finished job.
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
  delivery: deliverySchema.optional(),
  startedAt: instant.optional(),
  firstPdfAt: instant.optional(),
  engineFinishedAt: instant.optional(),
  publishedAt: instant.optional(),
});
export type JobTiming = z.infer<typeof jobTimingSchema>;

// Browser durations are measured with performance.now() from the compile
// action. They are never converted with the browser's wall clock.
export const previewTimingSchema = z.object({
  outcome: z.enum(["rendered", "preview_failed"]),
  submissionMs: duration,
  pollingMs: duration,
  downloadMs: duration,
  previewMs: duration,
  actionToPdfMs: duration,
  keystrokeToPdfMs: duration.nullable(),
  firstPdfByteMs: duration.nullable().optional(),
  // Clock anchors for the Logs timeline: the submission request leaving the
  // browser and the web route's own processing time, echoed from its response.
  requestSentMs: duration.optional(),
  serverMs: duration.optional(),
  // Arrival of the terminal build event over SSE.
  notifiedMs: duration.optional(),
});
export type PreviewTiming = z.infer<typeof previewTimingSchema>;
