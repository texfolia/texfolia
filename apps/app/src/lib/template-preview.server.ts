import { fetchCompiler } from "@texfolia/compile/server";
import type { Db } from "@texfolia/db";
import { template } from "@texfolia/db/schema";
import { assertProjectSourcePaths, projectPaths } from "@texfolia/projects";
import { encodeSource } from "@texfolia/storage";
import { InvalidSourcePathError } from "@texfolia/storage";
import type { SourceBucket } from "@texfolia/storage/server";
import { and, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { templateSnapshotSchema } from "./template.schema";

type Context = { db: Db; bucket: SourceBucket };
type StoredTemplate = typeof template.$inferSelect;
class TemplatePreviewError extends Error {}
const compilerStatusSchema = z.object({
  status: z.enum(["queued", "running", "succeeded", "failed"]),
});
async function compileSnapshot(found: StoredTemplate, bucket: SourceBucket) {
  const snapshot = templateSnapshotSchema.parse(found.snapshot);
  assertProjectSourcePaths(snapshot);
  const paths = projectPaths(snapshot);
  const files: Record<string, string | { base64: string }> = {};
  for (const node of snapshot) {
    const path = paths.get(node.id);
    if (!path) continue;
    const object = node.objectKey ? await bucket.get(node.objectKey) : null;
    if (!object)
      throw new TemplatePreviewError("Snapshot source is missing from storage");
    const bytes = new Uint8Array(await object.arrayBuffer());
    Object.defineProperty(files, path, {
      enumerable: true,
      value:
        node.kind === "text"
          ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          : { base64: encodeSource(bytes) },
    });
  }
  const body = JSON.stringify({
    mainFile: found.mainFile,
    files,
    preview: true,
  });
  if (new TextEncoder().encode(body).byteLength > 10 * 1024 * 1024)
    throw new TemplatePreviewError(
      "Encoded template exceeds the compiler's 10 MiB request limit",
    );
  return body;
}

export async function retryTemplatePreview({
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
  compiler,
  templateId,
}: Context & { compiler?: Pick<Fetcher, "fetch">; templateId?: string }) {
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
    // Each template renders in a temporary compiler project named by its ID.
    const previewProject = `/projects/${found.id}`;
    let settled = false;
    try {
      if (Date.now() - found.previewStartedAt.getTime() > 60 * 60_000)
        throw new TemplatePreviewError(
          "Preview generation expired. Retry this snapshot's preview.",
        );
      let response = await fetchCompiler(
        `${previewProject}/jobs/${found.previewJobId}`,
        undefined,
        compiler,
      );
      if (response.status === 404) {
        response = await fetchCompiler(
          `${previewProject}/compile`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Compilation-Id": found.previewJobId,
              "X-Compile-User": `template-preview:${found.id}`,
              "X-Compile-Plan": "pro",
            },
            body: await compileSnapshot(found, bucket),
          },
          compiler,
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
      if (result.status !== "succeeded") continue;
      const png = await fetchCompiler(
        `${previewProject}/compilations/${found.previewJobId}.png`,
        undefined,
        compiler,
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
        .set({ previewNextAttemptAt: new Date(Date.now() + 2000) })
        .where(currentAttempt);
      // The PNG is promoted or the attempt is over. Compiler retention removes
      // the temporary project a day later if this cleanup fails.
      if (settled)
        await fetchCompiler(
          `${previewProject}/build`,
          { method: "DELETE" },
          compiler,
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
