import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { putSource, type SourceBucket } from "@texfolia/storage/server";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import type { LockProject } from "./access";
import { createNodeSchema, renameNodeSchema } from "./node.schema";
import { newProjectNodePath, renamedProjectNodes } from "./paths";

// Callers invalidate the project build after these resolve.

export async function createProjectNode({
  db,
  ownerId,
  data,
  bucket,
  lock,
}: {
  db: Db;
  ownerId: string;
  lock: LockProject;
  data: z.infer<typeof createNodeSchema>;
  bucket?: SourceBucket;
}) {
  data = createNodeSchema.parse(data);
  return db.transaction(async (tx) => {
    await lock({ tx, projectId: data.projectId, userId: ownerId });
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId: data.projectId, deletedAt: { isNull: true } },
    });
    newProjectNodePath(nodes, data.parentId, data.name);
    const { content, ...metadata } = data;
    let stored: { objectKey: string | null; sizeBytes: bigint } = {
      objectKey: null,
      sizeBytes: 0n,
    };
    if (content !== undefined && data.kind !== "folder") {
      if (!bucket) throw new Error("Source storage unavailable");
      stored = await putSource({
        tx,
        bucket,
        projectId: data.projectId,
        content,
        previousSize: 0n,
        kind: data.kind,
      });
    }
    const [node] = await tx
      .insert(projectNode)
      .values({ ...metadata, ...stored })
      .returning({
        id: projectNode.id,
        projectId: projectNode.projectId,
        parentId: projectNode.parentId,
        name: projectNode.name,
        kind: projectNode.kind,
        updatedAt: projectNode.updatedAt,
      });
    if (!node) throw new Error("Failed to create file");
    await tx
      .update(project)
      .set({ updatedAt: new Date() })
      .where(eq(project.id, data.projectId));
    return {
      ...node,
      sourceVersion: {
        objectKey: stored.objectKey,
        updatedAt: node.updatedAt.getTime(),
      },
    };
  });
}

export async function renameProjectNode({
  db,
  userId,
  data,
  lock,
}: {
  db: Db;
  userId: string;
  lock: LockProject;
  data: z.infer<typeof renameNodeSchema>;
}) {
  data = renameNodeSchema.parse(data);
  await db.transaction(async (tx) => {
    await lock({ tx, projectId: data.projectId, userId });
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId: data.projectId, deletedAt: { isNull: true } },
    });
    renamedProjectNodes(nodes, data.nodeId, data.name, data.parentId);
    await tx
      .update(projectNode)
      .set({ name: data.name, parentId: data.parentId, updatedAt: new Date() })
      .where(
        and(
          eq(projectNode.id, data.nodeId),
          eq(projectNode.projectId, data.projectId),
        ),
      );
    await tx
      .update(project)
      .set({ updatedAt: new Date() })
      .where(eq(project.id, data.projectId));
  });
}
