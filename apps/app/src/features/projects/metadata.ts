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
  // Changes whenever the project's review comments change. Absent for
  // share-link guests.
  commentsVersion: z.string().optional(),
});
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

export function projectMetadataVersion({
  nodes,
  sourceVersions,
  textSource = "saved",
}: Pick<ProjectMetadata, "nodes" | "sourceVersions"> & {
  textSource?: "saved" | "live";
}) {
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify(
        [...nodes]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, parentId, name, kind }) => [
            id,
            parentId,
            name,
            kind,
            kind === "text" && textSource === "live"
              ? null
              : (sourceVersions[id]?.objectKey ?? null),
          ]),
      ),
    ),
  );
}
