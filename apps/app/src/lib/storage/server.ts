import type { Db } from "@texfolia/db";
import { project, projectNode, sourceGarbage } from "@texfolia/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  decodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
} from "./source";

// `R2Bucket` is the ambient Workers type from `wrangler types`.
export type SourceBucket = Pick<R2Bucket, "get" | "put" | "list" | "delete">;

// A transaction on the app database. Source writes join the caller's
// transaction so the node change and the stored object commit together.
export type SourceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function contentHash(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// Copies a stored source under another prefix, checking that it is intact. A
// null `from` stands for an empty file.
export async function copySource({
  bucket,
  from,
  to,
  sizeBytes,
}: {
  bucket: SourceBucket;
  from: string | null;
  to: string;
  sizeBytes: number;
}) {
  const object = from ? await bucket.get(from) : null;
  if (from && !object) throw new Error("Source is missing from storage");
  const bytes = object
    ? new Uint8Array(await object.arrayBuffer())
    : new Uint8Array();
  const hash = await contentHash(bytes);
  if (bytes.byteLength !== sizeBytes || (from && !from.endsWith(`/${hash}`)))
    throw new Error("Source integrity check failed");
  const objectKey = `${to}/${hash}`;
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return objectKey;
}

type SourceTarget = {
  tx: SourceTransaction;
  bucket: SourceBucket;
  projectId: string;
  previousSize: bigint;
};

// Stores base64 content from a request.
export async function putSource({
  content,
  kind,
  ...target
}: SourceTarget & { content: string; kind: "text" | "binary" }) {
  const bytes = decodeSource(content);
  checkSourceSize(bytes);
  if (kind === "text")
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return putSourceBytes({ ...target, bytes });
}

function checkSourceSize(bytes: Uint8Array) {
  if (bytes.byteLength > maxSourceFileBytes)
    throw new Error("File exceeds 10 MiB");
}

// Stores bytes the caller already has. Bytes of a text file must be UTF-8.
export async function putSourceBytes({
  tx,
  bucket,
  projectId,
  bytes,
  previousSize,
}: SourceTarget & { bytes: Uint8Array<ArrayBuffer> }) {
  checkSourceSize(bytes);
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
  const objectKey = `projects/${projectId}/sources/${await contentHash(bytes)}`;
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return { objectKey, sizeBytes };
}

// Queues keys that nodes stop referencing. Call it in the same transaction as
// the node change, so a rollback also discards the queue entry.
export async function retireSources(
  tx: SourceTransaction,
  projectId: string,
  objectKeys: Iterable<string | null | undefined>,
) {
  const keys = new Set<string>();
  for (const key of objectKeys) if (key) keys.add(key);
  if (keys.size)
    await tx
      .insert(sourceGarbage)
      .values([...keys].map((objectKey) => ({ projectId, objectKey })));
}

// Locks a project the way source writes do. The advisory lock also covers
// projects whose row is not committed yet or was removed by a cascade.
async function lockProjectForCollection(
  tx: SourceTransaction,
  projectId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`,
  );
  // Projects in the trash keep their sources; only a deleted row releases them.
  const [found] = await tx
    .select({ id: project.id })
    .from(project)
    .where(eq(project.id, projectId))
    .for("update");
  return Boolean(found);
}

async function liveSourceKeys(
  tx: SourceTransaction,
  projectId: string,
  keys: string[],
) {
  const references = keys.length
    ? await tx
        .select({ key: projectNode.objectKey })
        .from(projectNode)
        .where(
          and(
            eq(projectNode.projectId, projectId),
            isNull(projectNode.deletedAt),
            inArray(projectNode.objectKey, keys),
          ),
        )
    : [];
  return new Set(references.map((node) => node.key));
}

// R2 deletes at most 1,000 keys per call.
const garbageBatchSize = 1000;

// Deletes queued source objects that no live node references. Work scales with
// recently replaced or deleted sources, not with the bucket.
export async function collectSourceGarbage({
  db,
  bucket,
}: {
  db: Db;
  bucket: SourceBucket;
}) {
  const projectIds = await db
    .selectDistinct({ projectId: sourceGarbage.projectId })
    .from(sourceGarbage);
  for (const { projectId } of projectIds) {
    let remaining = true;
    while (remaining)
      remaining = await db.transaction(async (tx) => {
        const live = await lockProjectForCollection(tx, projectId);
        const queued = await tx
          .select()
          .from(sourceGarbage)
          .where(eq(sourceGarbage.projectId, projectId))
          .orderBy(sourceGarbage.id)
          .limit(garbageBatchSize);
        const keys = [...new Set(queued.map((row) => row.objectKey))];
        const liveKeys = live
          ? await liveSourceKeys(tx, projectId, keys)
          : new Set();
        const garbage = keys.filter(
          (key) =>
            key.startsWith(`projects/${projectId}/sources/`) &&
            !liveKeys.has(key),
        );
        if (garbage.length) await bucket.delete(garbage);
        if (queued.length)
          await tx.delete(sourceGarbage).where(
            inArray(
              sourceGarbage.id,
              queued.map((row) => row.id),
            ),
          );
        return queued.length === garbageBatchSize;
      });
  }
}

// Safety net for objects the queue cannot see: uploads whose SQL transaction
// rolled back and projects removed by account or organization cascades. It
// lists the whole prefix, so it runs daily rather than hourly.
export async function sweepProjectSources({
  db,
  bucket,
}: {
  db: Db;
  bucket: SourceBucket;
}) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: "projects/",
      cursor,
      limit: garbageBatchSize,
    });
    const byProject = new Map<string, string[]>();
    for (const object of page.objects) {
      const match =
        /^projects\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/sources\/[0-9a-f]{64}$/.exec(
          object.key,
        );
      if (!match?.[1]) continue;
      const keys = byProject.get(match[1]) ?? [];
      keys.push(object.key);
      byProject.set(match[1], keys);
    }
    for (const [projectId, keys] of byProject)
      await db.transaction(async (tx) => {
        const live = await lockProjectForCollection(tx, projectId);
        const liveKeys = live
          ? await liveSourceKeys(tx, projectId, keys)
          : new Set();
        const garbage = keys.filter((key) => !liveKeys.has(key));
        if (garbage.length) await bucket.delete(garbage);
      });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
