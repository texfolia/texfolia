import { z } from "zod";

const buildStateSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
});

export const buildSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  current: buildStateSchema.nullable().default(null),
  latestBuild: buildStateSchema.nullable().default(null),
  stale: z.boolean().default(false),
  artifacts: z
    .object({
      id: z.string(),
      revision: z.number(),
      digest: z.string(),
      builtAt: z.string(),
      builtBy: z.string(),
      engine: z.string(),
      pdf: z.string().nullable(),
      files: z.array(
        z.object({ path: z.string(), key: z.string(), sizeBytes: z.number() }),
      ),
    })
    .nullable()
    .default(null),
});
export type BuildSnapshot = z.infer<typeof buildSnapshotSchema>;
export type BuildFile = NonNullable<
  BuildSnapshot["artifacts"]
>["files"][number];
export function buildFileUrl(projectId: string, file: BuildFile) {
  return `/api/compile/${encodeURIComponent(projectId)}?file=${encodeURIComponent(file.path)}&version=${encodeURIComponent(file.key)}`;
}
