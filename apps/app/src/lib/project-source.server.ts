import { fetchCompiler } from "@texfolia/compile/server";
import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import type { saveSourceSchema } from "@texfolia/storage";
import {
  collectSourceGarbage,
  putSource,
  retireSources,
  type SourceBucket,
} from "@texfolia/storage/server";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import {
  cleanupDeletedCollaboration,
  collectCollaborationSources,
  type CollaborationCleanup,
} from "./collaboration/cleanup.server";
import { lockProject } from "./project-access.server";

export async function invalidateSourceBuild(
  projectId: string,
  compiler?: Fetcher,
) {
  try {
    const response = await fetchCompiler(
      `/projects/${projectId}/changed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editorId: crypto.randomUUID(), sequence: 0 }),
      },
      compiler,
    );
    if (!response.ok)
      throw new Error(`Build invalidation returned ${response.status}`);
  } catch (error) {
    console.error("Source committed but build invalidation failed", {
      projectId,
      error,
    });
  }
}

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
  const version = await db.transaction(async (tx) => {
    await lockProject({ tx, projectId: data.projectId, userId });
    const node = await tx.query.projectNode.findFirst({
      where: {
        id: data.nodeId,
        projectId: data.projectId,
        deletedAt: { isNull: true },
      },
    });
    if (!node || node.kind === "folder") throw new Error("File not found");
    if (node.objectKey !== data.expectedObjectKey)
      throw new Error(
        "File changed on the server. Reopen the project before recovering your local draft.",
      );
    const stored = await putSource({
      tx,
      bucket,
      projectId: data.projectId,
      content: data.content,
      previousSize: node.sizeBytes,
      kind: node.kind,
    });
    if (node.objectKey !== stored.objectKey)
      await retireSources(tx, data.projectId, [node.objectKey]);
    const updatedAt = new Date();
    await tx
      .update(projectNode)
      .set({ ...stored, updatedAt })
      .where(eq(projectNode.id, node.id));
    await tx
      .update(project)
      .set({ updatedAt })
      .where(eq(project.id, data.projectId));
    return { objectKey: stored.objectKey, updatedAt: updatedAt.getTime() };
  });
  await invalidateSourceBuild(data.projectId);
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
    await tx
      .update(project)
      .set({ updatedAt: new Date() })
      .where(eq(project.id, projectId));
  });
  await cleanupDeletedCollaboration(collaboration, projectId);
  await invalidateSourceBuild(projectId);
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
  return db.transaction(async (tx) => {
    await lockProject({ tx, projectId, userId, access: "read" });
    const node = await tx.query.projectNode.findFirst({
      where: { id: nodeId, projectId, deletedAt: { isNull: true } },
    });
    if (!node || node.kind === "folder") throw new Error("File not found");
    if (!node.objectKey) return new Uint8Array();
    const object = await bucket.get(node.objectKey);
    if (!object) throw new Error("Saved source is missing from storage");
    return new Uint8Array(await object.arrayBuffer());
  });
}

// Deletes queued source objects, then orphaned collaboration sources.
export async function collectProjectSources({
  db,
  bucket,
  collaboration,
}: {
  db: Db;
  bucket: SourceBucket;
  collaboration?: CollaborationCleanup;
}) {
  await collectSourceGarbage({ db, bucket });
  await collectCollaborationSources({ db, collaboration });
}
