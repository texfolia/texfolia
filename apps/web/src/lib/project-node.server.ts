import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";
import type { z } from "zod";

import { lockProject } from "./project-access.server";
import type { createNodeSchema } from "./project-node.schema";
import {
  invalidateSourceBuild,
  putSource,
  type SourceBucket,
} from "./project-source.server";

export async function createProjectNode({
  db,
  ownerId,
  data,
  bucket,
}: {
  db: Db;
  ownerId: string;
  data: z.infer<typeof createNodeSchema>;
  bucket?: SourceBucket;
}) {
  const created = await db.transaction(async (tx) => {
    await lockProject({ tx, projectId: data.projectId, userId: ownerId });
    const parent = await tx.query.projectNode.findFirst({
      where: {
        id: data.parentId,
        projectId: data.projectId,
        kind: "folder",
        deletedAt: { isNull: true },
      },
    });
    if (!parent) throw new Error("Folder not found");
    if (parent.parentId === null && data.name.toLowerCase() === "out")
      throw new Error("out/ is reserved for generated build files");
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
  await invalidateSourceBuild(data.projectId);
  return created;
}
