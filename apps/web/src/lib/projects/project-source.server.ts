import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import {
  invalidateSourceBuild,
  notifyProjectMetadataChanged,
} from "#/lib/builds/client";
import {
  cleanupDeletedCollaboration,
  collectCollaborationSources,
  requestCollaborationCleanup,
  type CollaborationCleanup,
} from "#/lib/collaboration/server";
import { lockProject } from "#/lib/sharing/project-access.server";
import { decodeSource, type saveSourceSchema } from "#/lib/storage";
import {
  checkProjectQuota,
  collectSourceGarbage,
  commitSources,
  prepareSourceBytes,
  retireSources,
  type SourceBucket,
} from "#/lib/storage/server";

export async function saveProjectSource({
  db,
  bucket,
  userId,
  data,
}: {
  db: Db;
  bucket: SourceBucket;
  userId: string;
  data: z.infer<typeof saveSourceSchema>;
}) {
  const { projectId } = data;
  const bytes = decodeSource(data.content);
  const upload = await prepareSourceBytes(projectId, bytes);
  const { objectKey, sizeBytes } = upload;
  const version = await commitSources({
    db,
    bucket,
    projectId,
    uploads: [upload],
    run: async (tx) => {
      await lockProject({ tx, projectId, userId });
      const node = await tx.query.projectNode.findFirst({
        where: {
          id: data.nodeId,
          projectId,
          deletedAt: { isNull: true },
        },
      });
      if (!node || node.kind === "folder") throw new Error("File not found");
      if (node.objectKey !== data.expectedObjectKey)
        throw new Error(
          "File changed on the server. Reopen the project before recovering your local draft.",
        );
      if (node.kind === "text")
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        );
      await checkProjectQuota(tx, projectId, {
        previousSize: node.sizeBytes,
        sizeBytes,
      });
      if (node.objectKey !== objectKey)
        await retireSources(tx, projectId, [node.objectKey]);
      const updatedAt = new Date();
      await tx
        .update(projectNode)
        .set({ objectKey, sizeBytes, updatedAt })
        .where(eq(projectNode.id, node.id));
      await tx
        .update(project)
        .set({ updatedAt })
        .where(eq(project.id, projectId));
      return { objectKey, updatedAt: updatedAt.getTime() };
    },
  });
  await Promise.all([
    invalidateSourceBuild(projectId),
    notifyProjectMetadataChanged(projectId),
  ]);
  return version;
}

export async function deleteProjectNode({
  db,
  userId,
  projectId,
  nodeId,
  collaboration,
}: {
  db: Db;
  userId: string;
  projectId: string;
  nodeId: string;
  collaboration?: CollaborationCleanup;
}) {
  await db.transaction(async (tx) => {
    await lockProject({ tx, projectId, userId });
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId, deletedAt: { isNull: true } },
    });
    const target = nodes.find((node) => node.id === nodeId);
    if (!target || target.parentId === null) throw new Error("File not found");
    const deleted = new Set([nodeId]);
    let previousSize = 0;
    while (previousSize !== deleted.size) {
      previousSize = deleted.size;
      for (const node of nodes)
        if (node.parentId && deleted.has(node.parentId)) deleted.add(node.id);
    }
    await retireSources(
      tx,
      projectId,
      nodes
        .filter((node) => deleted.has(node.id))
        .map((node) => node.objectKey),
    );
    await tx
      .update(projectNode)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(projectNode.projectId, projectId),
          inArray(projectNode.id, [...deleted]),
        ),
      );
    await requestCollaborationCleanup(tx, projectId);
    await tx
      .update(project)
      .set({ updatedAt: new Date() })
      .where(eq(project.id, projectId));
  });
  await cleanupDeletedCollaboration(collaboration, projectId);
  await Promise.all([
    invalidateSourceBuild(projectId),
    notifyProjectMetadataChanged(projectId),
  ]);
}

export async function readProjectSource({
  db,
  bucket,
  userId,
  projectId,
  nodeId,
}: {
  db: Db;
  bucket: SourceBucket;
  userId: string;
  projectId: string;
  nodeId: string;
}) {
  const objectKey = await db.transaction(async (tx) => {
    await lockProject({ tx, projectId, userId, access: "read" });
    const node = await tx.query.projectNode.findFirst({
      where: { id: nodeId, projectId, deletedAt: { isNull: true } },
    });
    if (!node || node.kind === "folder") throw new Error("File not found");
    return node.objectKey;
  });
  if (!objectKey) return new Uint8Array();
  const object = await bucket.get(objectKey);
  if (!object) throw new Error("Saved source is missing from storage");
  return new Uint8Array(await object.arrayBuffer());
}

// Deletes queued source objects, then orphaned collaboration sources.
export async function collectProjectSources({
  db,
  bucket,
  collaboration,
  retiredBefore,
}: {
  db: Db;
  bucket: SourceBucket;
  collaboration?: CollaborationCleanup;
  retiredBefore?: Date;
}) {
  // One failing must not hold up the other. They share a connection, so they
  // also take turns.
  const failures: unknown[] = [];
  for (const collect of [
    () => collectSourceGarbage({ db, bucket, retiredBefore }),
    () => collectCollaborationSources({ db, collaboration }),
  ])
    await collect().catch((error: unknown) => failures.push(error));
  if (failures.length)
    throw new AggregateError(failures, "Project source collection failed");
}
