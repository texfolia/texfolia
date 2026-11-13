import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { lockProject } from "../project-access.server";
import { encodeSource } from "../project-source";
import { putSource, type SourceBucket } from "../project-source.server";

export async function collaborationAccess(
  db: Db,
  projectId: string,
  nodeId: string,
  userId: string,
) {
  return db.transaction(async (tx) => {
    const access = await lockProject({ tx, projectId, userId, access: "read" });
    const node = await tx.query.projectNode.findFirst({
      where: {
        id: nodeId,
        projectId,
        kind: "text",
        deletedAt: { isNull: true },
      },
    });
    if (!node) throw new Error("File not found");
    return { node, canWrite: access.canWrite };
  });
}

// Accepted edits remain durable even if their author's access is later revoked.
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
      .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
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
