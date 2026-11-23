import type { LockProject, ProjectTransaction } from "./access";

// The file tree, saved source versions, and write access, read inside the
// caller's transaction under a shared project lock.
export async function readProjectMetadata({
  tx,
  projectId,
  userId,
  lock,
}: {
  tx: ProjectTransaction;
  projectId: string;
  userId: string;
  lock: LockProject;
}) {
  const { canWrite } = await lock({
    tx,
    projectId,
    userId,
    access: "read",
  });
  const rows = await tx.query.projectNode.findMany({
    where: { projectId, deletedAt: { isNull: true } },
  });
  return {
    nodes: rows.map(({ id, projectId, parentId, name, kind }) => ({
      id,
      projectId,
      parentId,
      name,
      kind,
    })),
    sourceVersions: Object.fromEntries(
      rows
        .filter((node) => node.kind !== "folder")
        .map((node) => [
          node.id,
          { objectKey: node.objectKey, updatedAt: node.updatedAt.getTime() },
        ]),
    ),
    canWrite,
  };
}
