import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod";

import { fetchCompiler } from "./compiler.server";
import { lockProject, type ProjectTransaction } from "./project-access.server";
import {
  decodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
  type saveSourceSchema,
} from "./project-source";

export type SourceBucket = Pick<R2Bucket, "get" | "put" | "list" | "delete">;

export async function putSource({
  tx,
  bucket,
  projectId,
  content,
  previousSize,
  kind,
}: {
  tx: ProjectTransaction;
  bucket: SourceBucket;
  projectId: string;
  content: string;
  previousSize: bigint;
  kind: "text" | "binary";
}) {
  const bytes = decodeSource(content);
  if (bytes.byteLength > maxSourceFileBytes)
    throw new Error("File exceeds 10 MiB");
  if (kind === "text") new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const [usage] = await tx
    .select({ bytes: sql<string>`coalesce(sum(${projectNode.sizeBytes}), 0)` })
    .from(projectNode)
    .where(
      and(eq(projectNode.projectId, projectId), isNull(projectNode.deletedAt)),
    );
  const sizeBytes = BigInt(bytes.byteLength);
  if (
    BigInt(usage?.bytes ?? 0) - previousSize + sizeBytes >
    BigInt(maxSourceProjectBytes)
  )
    throw new Error("Project exceeds 50 MiB");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const objectKey = `projects/${projectId}/sources/${hash}`;
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return { objectKey, sizeBytes };
}

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
}: {
  db: Db;
  userId: string;
  projectId: string;
  nodeId: string;
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

export async function collectProjectSources({
  db,
  bucket,
}: {
  db: Db;
  bucket: SourceBucket;
}) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "projects/", cursor, limit: 100 });
    const projectIds = new Set(
      page.objects.flatMap((object) => {
        const match =
          /^projects\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/sources\/[0-9a-f]{64}$/.exec(
            object.key,
          );
        return match?.[1] ? [match[1]] : [];
      }),
    );
    for (const projectId of projectIds)
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`,
        );
        const [found] = await tx
          .select()
          .from(project)
          .where(eq(project.id, projectId))
          .for("update");
        const references =
          found && !found.deletedAt
            ? await tx
                .select({ key: projectNode.objectKey })
                .from(projectNode)
                .where(
                  and(
                    eq(projectNode.projectId, projectId),
                    isNull(projectNode.deletedAt),
                  ),
                )
            : [];
        const liveKeys = new Set(references.map((node) => node.key));
        const garbage = page.objects.filter(
          (object) =>
            object.key.startsWith(`projects/${projectId}/sources/`) &&
            !liveKeys.has(object.key),
        );
        if (garbage.length)
          await bucket.delete(garbage.map((object) => object.key));
      });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
