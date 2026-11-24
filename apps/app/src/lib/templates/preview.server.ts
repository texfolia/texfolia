import { buildSnapshotSchema, type BuildSnapshot } from "@texfolia/contracts";
import { createDb, type Db } from "@texfolia/db";
import { template } from "@texfolia/db/schema";
import { and, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { connectBuilds, fetchBuilds } from "#/lib/builds/client";
import { assertProjectSourcePaths, projectPaths } from "#/lib/projects";
import { InvalidSourcePathError } from "#/lib/storage";
import type { SourceBucket } from "#/lib/storage/server";

import { findTemplate, isTemplateReviewer } from "./catalog.server";
import { templateSnapshotSchema } from "./schema";

type Context = { db: Db; bucket: SourceBucket };
type StoredTemplate = typeof template.$inferSelect;
class TemplatePreviewError extends Error {}
const compilerStatusSchema = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed"]),
});
// The saved objects the preview build compiles, by key.
function compileSnapshot(found: StoredTemplate) {
  const snapshot = templateSnapshotSchema.parse(found.snapshot);
  assertProjectSourcePaths(snapshot);
  const paths = projectPaths(snapshot);
  const files: Record<string, { hash: string; size: number; key: string }> = {};
  for (const node of snapshot) {
    const path = paths.get(node.id);
    if (!path) continue;
    const hash = node.objectKey?.split("/").at(-1);
    if (!node.objectKey || !hash)
      throw new TemplatePreviewError("Snapshot source is missing from storage");
    Object.defineProperty(files, path, {
      enumerable: true,
      value: { hash, size: node.sizeBytes, key: node.objectKey },
    });
  }
  return JSON.stringify({ mainFile: found.mainFile, files, preview: true });
}

async function retryTemplatePreview({
  db,
  templateId,
}: {
  db: Db;
  templateId: string;
}) {
  const [retried] = await db
    .update(template)
    .set({
      previewStatus: "queued",
      previewJobId: crypto.randomUUID(),
      previewStartedAt: new Date(),
      previewNextAttemptAt: new Date(),
      error: null,
    })
    .where(
      and(
        eq(template.id, templateId),
        eq(template.previewStatus, "failed"),
        lte(template.previewStartedAt, new Date(Date.now() - 60_000)),
      ),
    )
    .returning({ id: template.id });
  if (!retried)
    throw new Error("Wait a minute before retrying a failed preview.");
}

export async function refreshTemplatePreviews({
  db,
  bucket,
  builds,
  templateId,
}: Context & { builds?: Pick<Fetcher, "fetch">; templateId?: string }) {
  const queued = await db
    .select({ id: template.id, previewJobId: template.previewJobId })
    .from(template)
    .where(
      and(
        eq(template.previewStatus, "queued"),
        lte(template.previewNextAttemptAt, new Date()),
        templateId ? eq(template.id, templateId) : undefined,
      ),
    )
    .orderBy(template.previewNextAttemptAt, template.createdAt)
    .limit(10);
  for (const candidate of queued) {
    const [found] = await db
      .update(template)
      .set({ previewNextAttemptAt: new Date(Date.now() + 60_000) })
      .where(
        and(
          eq(template.id, candidate.id),
          eq(template.previewJobId, candidate.previewJobId),
          eq(template.previewStatus, "queued"),
          lte(template.previewNextAttemptAt, new Date()),
        ),
      )
      .returning();
    if (!found) continue;
    const currentAttempt = and(
      eq(template.id, found.id),
      eq(template.previewJobId, found.previewJobId),
      eq(template.previewStatus, "queued"),
      eq(template.previewNextAttemptAt, found.previewNextAttemptAt),
    );
    // Each template renders in a temporary project named by its ID.
    const previewProject = `/projects/${found.id}`;
    let settled = false;
    let backoffMs = 2000;
    try {
      if (Date.now() - found.previewStartedAt.getTime() > 60 * 60_000)
        throw new TemplatePreviewError(
          "Preview generation expired. Retry this snapshot's preview.",
        );
      let response = await fetchBuilds(
        `${previewProject}/jobs/${found.previewJobId}`,
        undefined,
        builds,
      );
      if (response.status === 404) {
        response = await fetchBuilds(
          `${previewProject}/compile`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Compilation-Id": found.previewJobId,
              "X-Compile-User": `template-preview:${found.id}`,
              "X-Compile-Plan": "pro",
            },
            body: compileSnapshot(found),
          },
          builds,
        );
        if (response.status === 400 || response.status === 413)
          throw new TemplatePreviewError(
            "Template could not be compiled. Check the main file and source size.",
          );
      }
      if (!response.ok) {
        console.error("Template preview service unavailable", {
          templateId: found.id,
          status: response.status,
        });
        continue;
      }
      const result = compilerStatusSchema.parse(await response.json());
      if (result.status === "failed")
        throw new TemplatePreviewError(
          "Preview compilation failed. Retry the preview, or publish corrected sources as a new snapshot.",
        );
      if (result.status !== "succeeded") {
        // The 60s lease already serialized this attempt; release immediately so
        // a completion event can promote the preview without waiting.
        backoffMs = 0;
        continue;
      }
      const png = await fetchBuilds(
        `${previewProject}/compilations/${found.previewJobId}.png`,
        undefined,
        builds,
      );
      if (!png.ok) throw new Error("Preview image was not available");
      const bytes = new Uint8Array(await png.arrayBuffer());
      if (
        bytes.byteLength > 4 * 1024 * 1024 ||
        ![137, 80, 78, 71, 13, 10, 26, 10].every(
          (byte, index) => bytes[index] === byte,
        )
      )
        throw new TemplatePreviewError("Invalid preview image");
      const previewKey = `templates/${found.id}/previews/${found.previewJobId}.png`;
      // Use the same lock as collection and seeding while promoting R2 objects.
      settled = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${found.id}, 0))`,
        );
        const [live] = await tx
          .select({ id: template.id })
          .from(template)
          .where(currentAttempt)
          .for("update");
        if (!live) return false;
        await bucket.put(previewKey, bytes, {
          httpMetadata: { contentType: "image/png" },
        });
        await tx
          .update(template)
          .set({ previewKey, previewStatus: "ready", error: null })
          .where(currentAttempt);
        return true;
      });
    } catch (error) {
      console.error("Template preview failed", { templateId: found.id, error });
      if (
        error instanceof TemplatePreviewError ||
        error instanceof InvalidSourcePathError
      )
        settled =
          (
            await db
              .update(template)
              .set({ previewStatus: "failed", error: error.message })
              .where(currentAttempt)
              .returning({ id: template.id })
          ).length > 0;
    } finally {
      await db
        .update(template)
        .set({ previewNextAttemptAt: new Date(Date.now() + backoffMs) })
        .where(currentAttempt);
      // The PNG is promoted or the attempt is over. Build retention removes
      // the temporary project a day later if this cleanup fails.
      if (settled)
        await fetchBuilds(
          `${previewProject}/build`,
          { method: "DELETE" },
          builds,
        )
          .then((response) => response.body?.cancel())
          .catch((error) => {
            console.error("Template preview cleanup failed", {
              templateId: found.id,
              error,
            });
          });
    }
  }
}

// Advances one visible template's preview. Only its owner or a reviewer can
// retry a failed attempt.
export async function refreshTemplatePreview({
  db,
  bucket,
  builds,
  templateId,
  retry,
  userId,
  reviewers = "",
}: Context & {
  builds?: Pick<Fetcher, "fetch">;
  templateId: string;
  retry: boolean;
  userId?: string;
  reviewers?: string;
}) {
  const found = await findTemplate({ db, templateId, userId, reviewers });
  if (!found) throw new Error("Template not found");
  if (retry) {
    if (
      !userId ||
      (found.ownerId !== userId && !isTemplateReviewer(userId, reviewers))
    )
      throw new Error("Template not found");
    await retryTemplatePreview({ db, templateId });
  }
  await refreshTemplatePreviews({ db, bucket, builds, templateId });
}

type PreviewRowState = Pick<StoredTemplate, "previewStatus" | "previewJobId">;

const sseHeaders = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "private, no-store",
  "X-Accel-Buffering": "no",
  "X-Robots-Tag": "noindex, nofollow",
};

function sseEvent(previewStatus: "ready" | "failed") {
  return `data: ${JSON.stringify({ previewStatus })}\n\n`;
}

function settledPreviewResponse(previewStatus: "ready" | "failed") {
  return new Response(sseEvent(previewStatus), { headers: sseHeaders });
}

function shouldCheckPreview(snapshot: BuildSnapshot, jobId: string) {
  const matching =
    snapshot.current?.id === jobId
      ? snapshot.current
      : snapshot.latestBuild?.id === jobId
        ? snapshot.latestBuild
        : null;
  if (matching)
    return matching.status === "succeeded" || matching.status === "failed";
  // If the temporary project was cleared or a retry replaced the job, re-check
  // the database so concurrent tabs receive the settled status.
  return !snapshot.current && !snapshot.latestBuild
    ? true
    : snapshot.current !== null && snapshot.current.id !== jobId;
}

const heartbeatMs = 15_000;

// Follows a queued template preview's builds and pushes a single terminal event
// (`ready` or `failed`) once settled.
export function createTemplatePreviewStream({
  templateId,
  initialJobId,
  advance,
  builds,
  signal,
}: {
  templateId: string;
  initialJobId: string;
  advance: () => Promise<PreviewRowState | null>;
  builds?: Pick<Fetcher, "fetch">;
  signal: AbortSignal;
}) {
  const encoder = new TextEncoder();
  let stop = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let socket: WebSocket | null = null;
      const heartbeat = setInterval(() => {
        send(": heartbeat\n\n");
      }, heartbeatMs);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        signal.removeEventListener("abort", close);
        socket?.close();
      };
      const close = () => {
        if (closed) return;
        stop();
        try {
          controller.close();
        } catch {
          // Already closed or cancelled by the consumer.
        }
      };
      const send = (chunk: string) => {
        if (!closed) controller.enqueue(encoder.encode(chunk));
      };
      const retry = (reason = "") => {
        send(`retry: 3000\n${reason}\n`);
        close();
      };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) {
        close();
        return;
      }
      let jobId = initialJobId;
      const settle = async () => {
        const next = await advance();
        if (closed) return;
        if (!next) {
          close();
          return;
        }
        if (next.previewStatus === "ready" || next.previewStatus === "failed") {
          send(sseEvent(next.previewStatus));
          close();
          return;
        }
        jobId = next.previewJobId;
      };
      // Snapshots are handled in order, one at a time.
      let queue = Promise.resolve();
      const enqueue = (work: () => Promise<void> | void) => {
        queue = queue.then(async () => {
          if (!closed) await work();
        });
        queue.catch(() => retry());
      };
      void (async () => {
        const response = await connectBuilds(templateId, null, builds);
        if (!response.webSocket) {
          await response.body?.cancel();
          retry(": unavailable\n");
          return;
        }
        socket = response.webSocket;
        socket.addEventListener("message", ({ data }) => {
          let snapshot: BuildSnapshot;
          try {
            snapshot = buildSnapshotSchema.parse(JSON.parse(String(data)));
          } catch {
            // Ignore malformed build event payloads.
            return;
          }
          enqueue(async () => {
            if (shouldCheckPreview(snapshot, jobId)) await settle();
          });
        });
        socket.addEventListener("close", () =>
          enqueue(async () => {
            await settle();
            retry();
          }),
        );
        socket.accept();
        if (closed) socket.close();
      })().catch(() => retry());
    },
    cancel() {
      stop();
    },
  });

  return new Response(body, { headers: sseHeaders });
}

async function readPreviewRow(db: Db, templateId: string) {
  const [row] = await db
    .select({
      previewStatus: template.previewStatus,
      previewJobId: template.previewJobId,
    })
    .from(template)
    .where(eq(template.id, templateId));
  return row ?? null;
}

// Starts or advances a queued preview and streams readiness over SSE until the
// preview is promoted to R2 (`ready`) or reaches a terminal failure (`failed`).
export async function streamTemplatePreview({
  db,
  connectionString,
  bucket,
  builds,
  found,
  signal,
}: Context & {
  connectionString: string;
  builds?: Pick<Fetcher, "fetch">;
  found: Pick<StoredTemplate, "id" | "previewStatus" | "previewJobId">;
  signal: AbortSignal;
}) {
  if (found.previewStatus === "ready" || found.previewStatus === "failed")
    return settledPreviewResponse(found.previewStatus);

  // Kick off or settle before returning headers while the request DB is open.
  await refreshTemplatePreviews({
    db,
    bucket,
    builds,
    templateId: found.id,
  });
  const current = await readPreviewRow(db, found.id);
  if (!current) return new Response("Not found", { status: 404 });
  if (current.previewStatus === "ready" || current.previewStatus === "failed")
    return settledPreviewResponse(current.previewStatus);

  return createTemplatePreviewStream({
    templateId: found.id,
    initialJobId: current.previewJobId,
    builds,
    signal,
    advance: async () => {
      // Request middleware closes its pool once the response headers return.
      const liveDb = createDb(connectionString);
      try {
        await refreshTemplatePreviews({
          db: liveDb,
          bucket,
          builds,
          templateId: found.id,
        });
        return await readPreviewRow(liveDb, found.id);
      } finally {
        await liveDb.$client.end();
      }
    },
  });
}
