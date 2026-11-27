import type { Db } from "@texfolia/db";
import { projectNode, sourceGarbage } from "@texfolia/db/schema";
import { and, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";

import { mapLimit } from "#/lib/map-limit";

import {
  decodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
  sourceHashFromKey,
} from "./source";

// `R2Bucket` is the ambient Workers type from `wrangler types`.
export type SourceBucket = Pick<R2Bucket, "get" | "put" | "list" | "delete">;

// A transaction on the app database.
export type SourceTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function contentHash(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sourcePrefix(projectId: string) {
  return `projects/${projectId}/sources/`;
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
  const expectedHash = from ? sourceHashFromKey(from) : null;
  if (bytes.byteLength !== sizeBytes || (from && expectedHash !== hash))
    throw new Error("Source integrity check failed");
  const objectKey = `${to}/${crypto.randomUUID()}-${hash}`;
  await bucket.put(objectKey, bytes, sourceOptions);
  return objectKey;
}

// One source, hashed and checked, ready for `commitSources`. A stored one is in
// the bucket already.
export type SourceUpload = {
  objectKey: string;
  sizeBytes: bigint;
  bytes: Uint8Array<ArrayBuffer> | (() => Promise<Uint8Array<ArrayBuffer>>);
  stored?: boolean;
};

const sourceOptions = {
  httpMetadata: { contentType: "application/octet-stream" },
};

// Prepares bytes the caller already has. Bytes of a text file must be UTF-8.
// Every upload gets a unique UUID prefix so retired keys are never reused.
export async function prepareSourceBytes(
  projectId: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  if (bytes.byteLength > maxSourceFileBytes)
    throw new Error("File exceeds 10 MiB");
  return {
    objectKey: `${sourcePrefix(projectId)}${crypto.randomUUID()}-${await contentHash(bytes)}`,
    sizeBytes: BigInt(bytes.byteLength),
    bytes,
  };
}

// Stores one source ahead of `commitSources`, so that many of them need not be in
// memory together.
export async function storeSource(
  bucket: Pick<SourceBucket, "put">,
  { objectKey, bytes }: { objectKey: string; bytes: Uint8Array<ArrayBuffer> },
) {
  await bucket.put(objectKey, bytes, sourceOptions);
}

// Prepares base64 content from a request.
export async function prepareSource(
  projectId: string,
  { content, kind }: { content: string; kind: "text" | "binary" },
) {
  const bytes = decodeSource(content);
  const upload = await prepareSourceBytes(projectId, bytes);
  if (kind === "text")
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  return upload;
}

// Callers that write hold the project lock, which serializes quotas.
export async function checkProjectQuota(
  tx: Pick<SourceTransaction, "select">,
  projectId: string,
  change: { previousSize: bigint; sizeBytes: bigint },
) {
  const [usage] = await tx
    .select({ bytes: sql<string>`coalesce(sum(${projectNode.sizeBytes}), 0)` })
    .from(projectNode)
    .where(
      and(eq(projectNode.projectId, projectId), isNull(projectNode.deletedAt)),
    );
  if (
    BigInt(usage?.bytes ?? 0) - change.previousSize + change.sizeBytes >
    BigInt(maxSourceProjectBytes)
  )
    throw new Error("Project exceeds 50 MiB");
}

/** How many source objects one operation reads or writes at once. */
export const sourceConcurrency = 6;
/** How many source bytes one operation holds for those reads or writes. */
export const sourceBytesInFlight = 16 * 1024 * 1024;

// Uploads sources to unique per-upload keys, then runs `run` in a transaction
// that points nodes at them. Because keys are unique, collection can never race
// with an upload, and a rolled-back transaction deletes its uploaded objects
// immediately.
export async function commitSources<T>({
  db,
  bucket,
  projectId,
  uploads,
  run,
}: {
  db: Db;
  bucket: SourceBucket;
  projectId: string;
  uploads: readonly SourceUpload[];
  run: (tx: SourceTransaction) => Promise<T>;
}): Promise<T> {
  const byKey = new Map(uploads.map((upload) => [upload.objectKey, upload]));
  const uploadedKeys: string[] = [];
  for (const upload of byKey.values())
    if (upload.stored) uploadedKeys.push(upload.objectKey);
  const pending = [...byKey.values()].filter((upload) => !upload.stored);
  try {
    await mapLimit(
      pending,
      sourceConcurrency,
      async ({ objectKey, bytes }) => {
        await storeSource(bucket, {
          objectKey,
          bytes: typeof bytes === "function" ? await bytes() : bytes,
        });
        uploadedKeys.push(objectKey);
      },
      {
        maxBytes: sourceBytesInFlight,
        size: ({ sizeBytes }) => Number(sizeBytes),
      },
    );
    return await db.transaction(run);
  } catch (error) {
    if (uploadedKeys.length)
      await bucket.delete(uploadedKeys).catch((deleteError: unknown) => {
        console.error("Failed to clean up uncommitted source uploads", {
          projectId,
          count: uploadedKeys.length,
          error: deleteError,
        });
      });
    throw error;
  }
}

// Queues keys that nodes stop referencing. Call it in the same transaction as
// the node change, so a rollback also discards the queue entry.
export async function retireSources(
  tx: Pick<SourceTransaction, "insert">,
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

async function liveSourceKeys(
  db: Pick<Db, "select">,
  projectId: string,
  keys: string[],
) {
  const references = keys.length
    ? await db
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

// Deletes every object under a prefix that nothing refers to any more.
export async function deletePrefix(
  bucket: Pick<SourceBucket, "list" | "delete">,
  prefix: string,
) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: garbageBatchSize });
    if (page.objects.length)
      await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

// Operations read sources outside the transaction that looked them up, so a
// retired object outlives any of them.
const retiredMs = 60 * 60_000;

// Deletes queued source objects that no live node references. Work scales with
// recently replaced or deleted sources, not with the bucket. Because keys are
// unique per upload, no project lock or two-phase claim is needed.
export async function collectSourceGarbage({
  db,
  bucket,
  retiredBefore = new Date(Date.now() - retiredMs),
}: {
  db: Db;
  bucket: SourceBucket;
  retiredBefore?: Date;
}) {
  let lastId = 0n;
  for (;;) {
    const queued = await db
      .select()
      .from(sourceGarbage)
      .where(
        and(
          gt(sourceGarbage.id, lastId),
          lte(sourceGarbage.createdAt, retiredBefore),
        ),
      )
      .orderBy(sourceGarbage.id)
      .limit(garbageBatchSize);
    if (!queued.length) break;
    lastId = queued[queued.length - 1]!.id;
    const byProject = new Map<string, string[]>();
    for (const row of queued) {
      const keys = byProject.get(row.projectId) ?? [];
      keys.push(row.objectKey);
      byProject.set(row.projectId, keys);
    }
    const toDelete = new Set<string>();
    for (const [projectId, projectKeys] of byProject) {
      const keys = [...new Set(projectKeys)];
      const kept = await liveSourceKeys(db, projectId, keys);
      const prefix = sourcePrefix(projectId);
      for (const key of keys)
        if (key.startsWith(prefix) && !kept.has(key)) toDelete.add(key);
    }
    if (toDelete.size) await bucket.delete([...toDelete]);
    await db.delete(sourceGarbage).where(
      inArray(
        sourceGarbage.id,
        queued.map((row) => row.id),
      ),
    );
  }
}
