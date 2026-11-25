import { z } from "zod";

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export const projectMetadataSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.uuid(),
      projectId: z.uuid(),
      parentId: z.uuid().nullable(),
      name: z.string(),
      kind: z.enum(["folder", "text", "binary"]),
    }),
  ),
  sourceVersions: z.record(
    z.string(),
    z.object({ objectKey: z.string().nullable(), updatedAt: z.number() }),
  ),
  canWrite: z.boolean(),
  // The chosen main document's path. See `projectMainFile`.
  mainFile: z.string().nullable().default(null),
  // Changes whenever the project's review comments change. Absent for
  // share-link guests.
  commentsVersion: z.string().optional(),
  // Changes whenever the project's linked Git repository changes. Absent for
  // share-link guests.
  gitVersion: z.string().optional(),
});
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

/** Changes with the metadata, whatever order its files are listed in. */
export function projectMetadataHash({
  nodes,
  sourceVersions,
  ...rest
}: ProjectMetadata) {
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify([
        [...nodes].sort((a, b) => byId(a.id, b.id)),
        Object.entries(sourceVersions).sort(([a], [b]) => byId(a, b)),
        rest,
      ]),
    ),
  );
}

export function projectSourcesFingerprint({
  nodes,
  sourceVersions,
  textSource = "saved",
}: {
  nodes: readonly ProjectMetadata["nodes"][number][];
  sourceVersions: Readonly<Record<string, { objectKey: string | null }>>;
  textSource?: "saved" | "live";
}) {
  return JSON.stringify(
    [...nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, parentId, name, kind }) => [
        id,
        parentId,
        name,
        kind,
        kind === "folder" || (kind === "text" && textSource === "live")
          ? null
          : (sourceVersions[id]?.objectKey ?? null),
      ]),
  );
}

export function projectMetadataVersion(
  options: Pick<ProjectMetadata, "nodes" | "sourceVersions"> & {
    textSource?: "saved" | "live";
  },
) {
  return sha256Hex(
    new TextEncoder().encode(projectSourcesFingerprint(options)),
  );
}
