import type { Db } from "@texfolia/db";
import {
  project,
  projectCollaboration,
  projectNode,
} from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import type { ProjectAccessRequest } from "#/lib/projects/server";
import {
  checkProjectQuota,
  commitSources,
  retireSources,
  type SourceBucket,
  type SourceUpload,
} from "#/lib/storage/server";

// Locks the project row and checks access, throwing to deny. The app owns which
// grants apply, such as collaborators and share links.
export type CollaborationLock = (request: ProjectAccessRequest) => Promise<{
  canWrite: boolean;
  /** Anonymous share-link guests. */
  guest: boolean;
}>;

export async function collaborationAccess(
  db: Db,
  projectId: string,
  nodeId: string,
  userId: string,
  options: { lock: CollaborationLock; register?: boolean },
) {
  return db.transaction(async (tx) => {
    const access = await options.lock({
      tx,
      projectId,
      userId,
      access: "read",
    });
    const node = await tx.query.projectNode.findFirst({
      where: {
        id: nodeId,
        projectId,
        kind: "text",
        deletedAt: { isNull: true },
      },
    });
    if (!node) throw new Error("File not found");
    if (options.register)
      await tx
        .insert(projectCollaboration)
        .values({ projectId })
        .onConflictDoNothing();
    return { node, canWrite: access.canWrite };
  });
}

// The scratchpad is for people signed in with access to the project, including
// through a share link; anonymous guests cannot open it. Editors may edit it.
export async function scratchpadAccess(
  db: Db,
  projectId: string,
  userId: string,
  options: { lock: CollaborationLock; register?: boolean },
) {
  return db.transaction(async (tx) => {
    const { canWrite, guest } = await options.lock({
      tx,
      projectId,
      userId,
      access: "read",
    });
    if (guest) throw new Error("File not found");
    if (options.register)
      await tx
        .insert(projectCollaboration)
        .values({ projectId })
        .onConflictDoNothing();
    return { canWrite };
  });
}

export type SourceNode = { objectKey: string | null; updatedAt: Date };

// Callers verify access first; this only reads a live text node.
export async function sourceNode(
  db: Db,
  projectId: string,
  nodeId: string,
): Promise<SourceNode> {
  const [node] = await db
    .select({
      objectKey: projectNode.objectKey,
      updatedAt: projectNode.updatedAt,
    })
    .from(projectNode)
    .innerJoin(project, eq(project.id, projectNode.projectId))
    .where(
      and(
        eq(projectNode.id, nodeId),
        eq(projectNode.projectId, projectId),
        eq(projectNode.kind, "text"),
        isNull(projectNode.deletedAt),
        isNull(project.deletedAt),
      ),
    );
  if (!node) throw new Error("File not found");
  return node;
}

// Accepted edits remain durable even if their author's access is later revoked
// or the project moves to the trash. Returns null when the file is gone.
export async function persistMergedSource(options: {
  db: Db;
  bucket: SourceBucket;
  projectId: string;
  nodeId: string;
  /** The versions this save may replace, besides its own from an earlier try. */
  expectedObjectKeys: readonly (string | null)[];
  upload: SourceUpload;
}) {
  const { db, bucket, projectId, nodeId, expectedObjectKeys, upload } = options;
  const { objectKey, sizeBytes } = upload;
  const readNode = (tx: Pick<Db, "query">) =>
    tx.query.projectNode.findFirst({
      where: {
        id: nodeId,
        projectId,
        kind: "text",
        deletedAt: { isNull: true },
      },
    });
  // A file that is gone or over its quota must not leave an upload per edit.
  const found = await readNode(db);
  if (!found) return null;
  await checkProjectQuota(db, projectId, {
    previousSize: found.sizeBytes,
    sizeBytes,
  });
  return commitSources({
    db,
    bucket,
    projectId,
    uploads: [upload],
    run: async (tx) => {
      const [live] = await tx
        .select({ id: project.id })
        .from(project)
        .where(eq(project.id, projectId))
        .for("update");
      const node = live && (await readNode(tx));
      if (!node) return null;
      await checkProjectQuota(tx, projectId, {
        previousSize: node.sizeBytes,
        sizeBytes,
      });
      // A retry after a successful SQL commit is safe; other external writes are conflicts.
      if (
        node.objectKey !== objectKey &&
        !expectedObjectKeys.includes(node.objectKey)
      )
        throw new Error(
          "Source changed outside collaboration. Reopen the project before saving.",
        );
      if (node.objectKey !== objectKey)
        await retireSources(tx, projectId, [node.objectKey]);
      const updatedAt = new Date();
      await tx
        .update(projectNode)
        .set({ objectKey, sizeBytes, updatedAt })
        .where(eq(projectNode.id, nodeId));
      await tx
        .update(project)
        .set({ updatedAt })
        .where(eq(project.id, projectId));
      return { objectKey, updatedAt: updatedAt.getTime() };
    },
  });
}
