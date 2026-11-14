import { z } from "zod";

import { hashSource } from "./latex/source-sync";

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
});
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

export function projectMetadataVersion({
  nodes,
  sourceVersions,
}: Pick<ProjectMetadata, "nodes" | "sourceVersions">) {
  return hashSource(
    new TextEncoder().encode(
      JSON.stringify(
        [...nodes]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, parentId, name, kind }) => [
            id,
            parentId,
            name,
            kind,
            sourceVersions[id]?.objectKey ?? null,
          ]),
      ),
    ),
  );
}
