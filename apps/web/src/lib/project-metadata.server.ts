import type { Db } from "@texfolia/db";

import {
  lockProject,
  shareLinkIdOf,
  type ProjectTransaction,
} from "./project-access.server";
import { commentsVersion } from "./project-comments.server";

export async function readProjectMetadata({
  tx,
  projectId,
  userId,
}: {
  tx: ProjectTransaction;
  projectId: string;
  userId: string;
}) {
  const { canWrite } = await lockProject({
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

export function getProjectMetadata({
  db,
  ...options
}: {
  db: Db;
  projectId: string;
  userId: string;
}) {
  return db.transaction(async (tx) => {
    const metadata = await readProjectMetadata({ tx, ...options });
    return {
      ...metadata,
      // Share-link guests cannot see comments.
      commentsVersion:
        shareLinkIdOf(options.userId) === null
          ? await commentsVersion(tx, options.projectId)
          : undefined,
    };
  });
}
