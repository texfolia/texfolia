import type { Db } from "@texfolia/db";
import { project, projectNode, sourceGarbage } from "@texfolia/db/schema";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";

import { mapLimit } from "#/lib/map-limit";

import {
  decodeSource,
  maxSourceFileBytes,
  maxSourceProjectBytes,
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
  if (bytes.byteLength !== sizeBytes || (from && !from.endsWith(`/${hash}`)))
    throw new Error("Source integrity check failed");
  const objectKey = `${to}/${hash}`;
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return objectKey;
}

// One source's bytes, hashed and checked, ready for `commitSources`.
export type SourceUpload = {
  objectKey: string;
  sizeBytes: bigint;
  bytes: Uint8Array<ArrayBuffer>;
};

// Prepares bytes the caller already has. Bytes of a text file must be UTF-8.
export async function prepareSourceBytes(
  projectId: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<SourceUpload> {
  if (bytes.byteLength > maxSourceFileBytes)
    throw new Error("File exceeds 10 MiB");
  return {
    objectKey: `${sourcePrefix(projectId)}${await contentHash(bytes)}`,
    sizeBytes: BigInt(bytes.byteLength),
    bytes,
  };
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

// Collection is done with a claim after this long, even if it crashed.
const claimTimeoutMs = 5 * 60_000;
const claimRetries = 20;
const claimRetryMs = 250;

// Collection claimed one of the objects, so it may be gone.
class SourceClaimedError extends Error {}

// Uploads sources, then runs `run` in a transaction that points nodes at them.
// `run` must lock the project row for writing (or insert it), and may run more
// than once. No transaction is open during an upload, so collection may delete an
// object between its upload and the commit. It leaves a claim behind, which this
// finds under the same lock, uploads the object again, and retries.
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
  // Claims whose delete had finished before the last upload.
  const settled = new Set<string>();
  let pending = [...byKey.values()];
  for (let attempt = 0; ; attempt++) {
    await mapLimit(pending, sourceConcurrency, ({ objectKey, bytes }) =>
      bucket.put(objectKey, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
      }),
    );
    pending = [];
    let deleting = false;
    try {
      return await db.transaction(async (tx) => {
        const result = await run(tx);
        const claims = byKey.size
          ? await tx
              .select()
              .from(sourceGarbage)
              .where(
                and(
                  eq(sourceGarbage.projectId, projectId),
                  inArray(sourceGarbage.objectKey, [...byKey.keys()]),
                  isNotNull(sourceGarbage.claimedAt),
                ),
              )
          : [];
        for (const { id, objectKey, claimedAt, deletedAt } of claims) {
          const claim = `${id}:${claimedAt?.getTime()}`;
          if (settled.has(claim)) continue;
          if (
            deletedAt ||
            (claimedAt && claimedAt.getTime() < Date.now() - claimTimeoutMs)
          ) {
            settled.add(claim);
            const upload = byKey.get(objectKey);
            if (upload) pending.push(upload);
          } else deleting = true;
        }
        if (deleting || pending.length) throw new SourceClaimedError();
        return result;
      });
    } catch (error) {
      if (!(error instanceof SourceClaimedError)) throw error;
      if (attempt >= claimRetries)
        throw new Error("Source storage is busy. Try again.");
      if (deleting)
        await new Promise((resolve) => setTimeout(resolve, claimRetryMs));
    }
  }
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

// Locks a project the way source writes do. Projects in the trash keep their
// sources; only a deleted row releases them.
async function lockProjectForCollection(
  tx: SourceTransaction,
  projectId: string,
) {
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

// Deletes claimed objects, then records that they are gone. A failure leaves the
// claims, which the next collection takes over.
async function deleteClaimed(
  { db, bucket }: { db: Db; bucket: SourceBucket },
  claimed: { id: bigint; objectKey: string }[],
) {
  if (!claimed.length) return;
  await bucket.delete([...new Set(claimed.map((row) => row.objectKey))]);
  await db
    .update(sourceGarbage)
    .set({ deletedAt: new Date() })
    .where(
      inArray(
        sourceGarbage.id,
        claimed.map((row) => row.id),
      ),
    );
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
// recently replaced or deleted sources, not with the bucket.
export async function collectSourceGarbage({
  db,
  bucket,
  retiredBefore = new Date(Date.now() - retiredMs),
}: {
  db: Db;
  bucket: SourceBucket;
  retiredBefore?: Date;
}) {
  await db
    .delete(sourceGarbage)
    .where(lt(sourceGarbage.deletedAt, new Date(Date.now() - retiredMs)));
  const due = and(
    lte(sourceGarbage.createdAt, retiredBefore),
    isNull(sourceGarbage.deletedAt),
    or(
      isNull(sourceGarbage.claimedAt),
      lt(sourceGarbage.claimedAt, new Date(Date.now() - claimTimeoutMs)),
    ),
  );
  const projectIds = await db
    .selectDistinct({ projectId: sourceGarbage.projectId })
    .from(sourceGarbage)
    .where(due);
  for (const { projectId } of projectIds) {
    let remaining = true;
    while (remaining) {
      const batch = await db.transaction(async (tx) => {
        const live = await lockProjectForCollection(tx, projectId);
        const queued = await tx
          .select()
          .from(sourceGarbage)
          .where(and(eq(sourceGarbage.projectId, projectId), due))
          .orderBy(sourceGarbage.id)
          .limit(garbageBatchSize);
        const keys = [...new Set(queued.map((row) => row.objectKey))];
        const kept = live
          ? await liveSourceKeys(tx, projectId, keys)
          : new Set<string | null>();
        // Used and retired again since: the newer row waits its own time.
        if (keys.length)
          for (const { objectKey } of await tx
            .select({ objectKey: sourceGarbage.objectKey })
            .from(sourceGarbage)
            .where(
              and(
                eq(sourceGarbage.projectId, projectId),
                inArray(sourceGarbage.objectKey, keys),
                gt(sourceGarbage.createdAt, retiredBefore),
                isNull(sourceGarbage.deletedAt),
              ),
            ))
            kept.add(objectKey);
        const claimed = queued.filter(
          (row) =>
            row.objectKey.startsWith(sourcePrefix(projectId)) &&
            !kept.has(row.objectKey),
        );
        const claimedIds = new Set(claimed.map((row) => row.id));
        const released = queued.filter((row) => !claimedIds.has(row.id));
        if (released.length)
          await tx.delete(sourceGarbage).where(
            inArray(
              sourceGarbage.id,
              released.map((row) => row.id),
            ),
          );
        if (claimed.length)
          await tx
            .update(sourceGarbage)
            .set({ claimedAt: new Date() })
            .where(inArray(sourceGarbage.id, [...claimedIds]));
        return { claimed, remaining: queued.length === garbageBatchSize };
      });
      await deleteClaimed({ db, bucket }, batch.claimed);
      ({ remaining } = batch);
    }
  }
}

// Long enough for any upload whose transaction has yet to commit.
const unreferencedMs = 24 * 60 * 60_000;

// Safety net for objects the queue cannot see: uploads whose SQL transaction
// rolled back and projects removed by account or organization cascades. It
// lists the whole prefix, so it runs daily rather than hourly.
export async function sweepProjectSources({
  db,
  bucket,
  uploadedBefore = new Date(Date.now() - unreferencedMs),
}: {
  db: Db;
  bucket: SourceBucket;
  uploadedBefore?: Date;
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
      if (!match?.[1] || object.uploaded > uploadedBefore) continue;
      const keys = byProject.get(match[1]) ?? [];
      keys.push(object.key);
      byProject.set(match[1], keys);
    }
    for (const [projectId, keys] of byProject) {
      const claimed = await db.transaction(async (tx) => {
        const live = await lockProjectForCollection(tx, projectId);
        const kept = live
          ? await liveSourceKeys(tx, projectId, keys)
          : new Set<string | null>();
        // Queued objects are the hourly collection's.
        for (const { objectKey } of await tx
          .select({ objectKey: sourceGarbage.objectKey })
          .from(sourceGarbage)
          .where(
            and(
              eq(sourceGarbage.projectId, projectId),
              inArray(sourceGarbage.objectKey, keys),
              isNull(sourceGarbage.deletedAt),
            ),
          ))
          kept.add(objectKey);
        const garbage = keys.filter((key) => !kept.has(key));
        return garbage.length
          ? tx
              .insert(sourceGarbage)
              .values(
                garbage.map((objectKey) => ({
                  projectId,
                  objectKey,
                  claimedAt: new Date(),
                })),
              )
              .returning({
                id: sourceGarbage.id,
                objectKey: sourceGarbage.objectKey,
              })
          : [];
      });
      await deleteClaimed({ db, bucket }, claimed);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
