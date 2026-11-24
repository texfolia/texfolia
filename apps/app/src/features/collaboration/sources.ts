import type { Db } from "@texfolia/db";
import {
  project,
  projectCollaboration,
  projectNode,
} from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import type { ProjectAccessRequest } from "#/features/projects/server";
import { encodeSource } from "#/features/storage";
import {
  putSource,
  retireSources,
  type SourceBucket,
} from "#/features/storage/server";

// Locks the project row and checks access, throwing to deny. The app owns which
// grants apply, such as collaborators and share links.
export type CollaborationLock = (
  request: ProjectAccessRequest,
) => Promise<{ canWrite: boolean }>;

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
// or the project moves to the trash.
export async function persistMergedSource(options: {
  db: Db;
  bucket: SourceBucket;
  projectId: string;
  nodeId: string;
  expectedObjectKey: string | null;
  value: string;
}) {
  const { db, bucket, projectId, nodeId, expectedObjectKey, value } = options;
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(project)
      .where(eq(project.id, projectId))
      .for("update");
    if (!found) return null;
    const node = await tx.query.projectNode.findFirst({
      where: {
        id: nodeId,
        projectId,
        kind: "text",
        deletedAt: { isNull: true },
      },
    });
    if (!node) return null;
    const content = encodeSource(new TextEncoder().encode(value));
    const stored = await putSource({
      tx,
      bucket,
      projectId,
      content,
      previousSize: node.sizeBytes,
      kind: "text",
    });
    // A retry after a successful SQL commit is safe; other external writes are conflicts.
    if (
      node.objectKey !== expectedObjectKey &&
      node.objectKey !== stored.objectKey
    )
      throw new Error(
        "Source changed outside collaboration. Reopen the project before saving.",
      );
    if (node.objectKey !== stored.objectKey)
      await retireSources(tx, projectId, [node.objectKey]);
    const updatedAt = new Date();
    await tx
      .update(projectNode)
      .set({ ...stored, updatedAt })
      .where(eq(projectNode.id, nodeId));
    await tx
      .update(project)
      .set({ updatedAt })
      .where(eq(project.id, projectId));
    return { objectKey: stored.objectKey, updatedAt: updatedAt.getTime() };
  });
}
