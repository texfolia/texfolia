import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import {
  checkProjectQuota,
  commitSources,
  prepareSource,
  type SourceBucket,
} from "#/lib/storage/server";

import type { LockProject, ProjectTransaction } from "./access";
import { movedMainFile } from "./main-file";
import { createNodeSchema, renameNodeSchema } from "./node.schema";
import {
  newProjectNodePath,
  projectNodePaths,
  renamedProjectNodes,
} from "./paths";

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
  const { content, ...metadata } = data;
  const { projectId, kind } = data;
  const check = async (tx: ProjectTransaction) => {
    await lock({ tx, projectId, userId: ownerId });
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId, deletedAt: { isNull: true } },
    });
    newProjectNodePath(nodes, data.parentId, data.name);
  };
  const insert = async (
    tx: ProjectTransaction,
    stored: { objectKey: string | null; sizeBytes: bigint },
  ) => {
    await check(tx);
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
      .where(eq(project.id, projectId));
    return {
      ...node,
      sourceVersion: {
        objectKey: stored.objectKey,
        updatedAt: node.updatedAt.getTime(),
      },
    };
  };
  if (content === undefined || kind === "folder")
    return db.transaction((tx) =>
      insert(tx, { objectKey: null, sizeBytes: 0n }),
    );
  if (!bucket) throw new Error("Source storage unavailable");
  // Nothing is stored for a caller without access or at an invalid path.
  await db.transaction(check);
  const upload = await prepareSource(projectId, { content, kind });
  const { objectKey, sizeBytes } = upload;
  return commitSources({
    db,
    bucket,
    projectId,
    uploads: [upload],
    run: async (tx) => {
      const created = await insert(tx, { objectKey, sizeBytes });
      // The new file is already counted.
      await checkProjectQuota(tx, projectId, {
        previousSize: 0n,
        sizeBytes: 0n,
      });
      return created;
    },
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
    const found = await lock({ tx, projectId: data.projectId, userId });
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId: data.projectId, deletedAt: { isNull: true } },
    });
    const renamed = renamedProjectNodes(
      nodes,
      data.nodeId,
      data.name,
      data.parentId,
    );
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
      .set({
        updatedAt: new Date(),
        mainFile: movedMainFile(
          found.mainFile,
          projectNodePaths(nodes),
          projectNodePaths(renamed),
        ),
      })
      .where(eq(project.id, data.projectId));
  });
}
