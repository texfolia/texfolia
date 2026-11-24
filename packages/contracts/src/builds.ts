import { z } from "zod";

import { artifactPathSchema } from "./paths";
import { jobTimingSchema } from "./telemetry";

export const maxPdfBytes = 20 * 1024 * 1024;
export const jobIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
export const buildStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
]);
export type BuildStatus = z.infer<typeof buildStatusSchema>;

// The fields of a compile job that the compiler returns to the web app. The
// compiler stores more fields; it extends these schemas with them.
const jobFields = {
  id: jobIdSchema,
  revision: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  log: z.string().default(""),
  timing: jobTimingSchema.optional(),
};
export const queuedJobSchema = z.object({
  ...jobFields,
  status: z.literal("queued"),
});
export const runningJobSchema = z.object({
  ...jobFields,
  status: z.literal("running"),
});
export const succeededJobSchema = z.object({
  ...jobFields,
  status: z.literal("succeeded"),
  artifactUrl: z.string(),
  sizeBytes: z.number().int().nonnegative().max(maxPdfBytes),
});
export const failedJobSchema = z.object({
  ...jobFields,
  status: z.literal("failed"),
  error: z.string(),
});
export const compileJobSchema = z.discriminatedUnion("status", [
  queuedJobSchema,
  runningJobSchema,
  succeededJobSchema,
  failedJobSchema,
]);
export type CompileJob = z.infer<typeof compileJobSchema>;

// The compiler's 202 response to a submission.
export const acceptedJobSchema = z.discriminatedUnion("status", [
  queuedJobSchema.extend({ supersededId: jobIdSchema.optional() }),
  runningJobSchema.extend({ supersededId: jobIdSchema.optional() }),
]);

export const artifactManifestSchema = z.object({
  id: z.string(),
  revision: z.number(),
  digest: z.string(),
  builtAt: z.string(),
  builtBy: z.string(),
  engine: z.string(),
  pdf: artifactPathSchema.nullable(),
  files: z.array(
    z.object({
      path: artifactPathSchema,
      key: z.string(),
      sizeBytes: z.number(),
    }),
  ),
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

const buildStateSchema = z.object({
  id: jobIdSchema,
  revision: z.number().int().nonnegative(),
  status: buildStatusSchema,
});
// The project build state the compiler publishes on GET and over its event socket.
export const buildSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  current: buildStateSchema.nullable().default(null),
  latestBuild: buildStateSchema.nullable().default(null),
  stale: z.boolean().default(false),
  artifacts: artifactManifestSchema.nullable().default(null),
});
export type BuildSnapshot = z.infer<typeof buildSnapshotSchema>;
