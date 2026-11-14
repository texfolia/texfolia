import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectNode,
  template,
  templateReport,
  user,
} from "@texfolia/db/schema";
import { InvalidSourcePathError } from "@texfolia/project-paths";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { fetchCompiler } from "./compiler.server";
import { hashSource } from "./latex/source-sync";
import { lockProject } from "./project-access.server";
import { assertProjectSourcePaths, projectPaths } from "./project-paths";
import { encodeSource } from "./project-source";
import type { SourceBucket } from "./project-source.server";
import {
  openTemplateSchema,
  publishTemplateSchema,
  templateSnapshotSchema,
} from "./template.schema";
import { createZip } from "./zip";

type Context = { db: Db; bucket: SourceBucket };
type StoredTemplate = typeof template.$inferSelect;
type Snapshot = z.infer<typeof templateSnapshotSchema>;
class TemplatePreviewError extends Error {}
const publicColumns = {
  id: template.id,
  title: template.title,
  description: template.description,
  tags: template.tags,
  license: template.license,
  visibility: template.visibility,
  publisherName: template.publisherName,
  createdAt: template.createdAt,
  status: template.status,
};
export const isTemplateReviewer = (userId: string, reviewers: string) =>
  reviewers
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);

export async function listTemplates({
  db,
  page = 0,
}: {
  db: Db;
  page?: number;
}) {
  return db
    .select(publicColumns)
    .from(template)
    .where(
      and(eq(template.status, "approved"), eq(template.visibility, "public")),
    )
    .orderBy(desc(template.createdAt), desc(template.id))
    .limit(24)
    .offset(page * 24);
}

export async function findTemplate({
  db,
  templateId,
  userId,
  reviewers = "",
}: {
  db: Db;
  templateId: string;
  userId?: string;
  reviewers?: string;
}) {
  const [found] = await db
    .select()
    .from(template)
    .where(eq(template.id, templateId));
  if (
    !found ||
    (found.status !== "approved" &&
      found.ownerId !== userId &&
      !(userId && isTemplateReviewer(userId, reviewers)))
  )
    return null;
  return found;
}

export async function listMyTemplates({
  db,
  userId,
}: {
  db: Db;
  userId: string;
}) {
  return db
    .select(publicColumns)
    .from(template)
    .where(eq(template.ownerId, userId))
    .orderBy(desc(template.createdAt))
    .limit(100);
}

export async function getTemplate(options: Parameters<typeof findTemplate>[0]) {
  const found = await findTemplate(options);
  if (!found) return null;
  return {
    id: found.id,
    title: found.title,
    description: found.description,
    tags: found.tags,
    license: found.license,
    visibility: found.visibility,
    publisherName: found.publisherName,
    createdAt: found.createdAt,
    status: found.status,
    hasPreview: !!found.previewKey,
    error: found.ownerId === options.userId ? found.error : null,
    fileCount: templateSnapshotSchema
      .parse(found.snapshot)
      .filter((node) => node.kind !== "folder").length,
  };
}

export async function templateDestinations({
  db,
  userId,
}: {
  db: Db;
  userId: string;
}) {
  return db
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId));
}

async function copyObject({
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
  if (from && !object)
    throw new Error("Snapshot source is missing from storage");
  const bytes = object
    ? new Uint8Array(await object.arrayBuffer())
    : new Uint8Array();
  const hash = await hashSource(bytes);
  if (bytes.byteLength !== sizeBytes || (from && !from.endsWith(`/${hash}`)))
    throw new Error("Snapshot source integrity check failed");
  const objectKey = `${to}/${hash}`;
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  return objectKey;
}

export async function publishTemplate({
  db,
  bucket,
  userId,
  data,
  templateId = crypto.randomUUID(),
}: Context & {
  userId: string;
  data: z.infer<typeof publishTemplateSchema>;
  templateId?: string;
}) {
  data = publishTemplateSchema.parse(data);
  return db.transaction(async (tx) => {
    const [publisher] = await tx
      .select()
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (!publisher) throw new Error("Unauthorized");
    const [existing] = await tx
      .select({ id: template.id, ownerId: template.ownerId })
      .from(template)
      .where(eq(template.id, templateId));
    if (existing) {
      if (existing.ownerId !== userId)
        throw new Error("Template ID already exists");
      return { id: existing.id };
    }
    const recent = await tx
      .select({ createdAt: template.createdAt })
      .from(template)
      .where(
        and(
          eq(template.ownerId, userId),
          gte(template.createdAt, new Date(Date.now() - 24 * 60 * 60_000)),
        ),
      );
    if (
      recent.length >= 10 ||
      recent.filter((row) => row.createdAt.getTime() > Date.now() - 60 * 60_000)
        .length >= 3
    )
      throw new Error(
        "Publishing limit reached. Try again later (3 per hour, 10 per day).",
      );
    const source = await lockProject({
      tx,
      projectId: data.projectId,
      userId,
      access: "read",
    });
    let publisherName = publisher.name;
    if (source.organizationId) {
      const [membership] = await tx
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, source.organizationId),
            eq(member.userId, userId),
          ),
        )
        .for("share");
      if (
        !membership ||
        !membership.role
          .split(",")
          .some((role) => role === "owner" || role === "admin")
      )
        throw new Error(
          "Only organization owners and admins can publish templates",
        );
      const [org] = await tx
        .select()
        .from(organization)
        .where(eq(organization.id, source.organizationId));
      if (!org) throw new Error("Organization not found");
      publisherName = org.name;
    } else if (source.ownerId !== userId)
      throw new Error("Only the project owner can publish templates");
    const nodes = await tx.query.projectNode.findMany({
      where: { projectId: data.projectId, deletedAt: { isNull: true } },
    });
    assertProjectSourcePaths(nodes);
    const paths = projectPaths(nodes);
    if (
      nodes.length > 401 ||
      paths.size < 1 ||
      paths.size > 200 ||
      ![...paths.values()].includes(data.mainFile) ||
      !data.mainFile.endsWith(".tex")
    )
      throw new Error(
        "Select a .tex main file in a project with 1–200 files and no more than 401 nodes",
      );
    if (
      nodes.reduce((size, node) => size + node.sizeBytes, 0n) >=
      10n * 1024n * 1024n
    )
      throw new Error("Template exceeds the compiler's 10 MiB source limit");
    const snapshot: Snapshot = [];
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${templateId}, 0))`,
    );
    for (const node of nodes) {
      snapshot.push({
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        kind: node.kind,
        sizeBytes: Number(node.sizeBytes),
        objectKey:
          node.kind === "folder"
            ? null
            : await copyObject({
                bucket,
                from: node.objectKey,
                to: `templates/${templateId}/sources`,
                sizeBytes: Number(node.sizeBytes),
              }),
      });
    }
    await tx.insert(template).values({
      id: templateId,
      ownerId: userId,
      organizationId: source.organizationId,
      publisherName,
      title: data.title,
      description: data.description,
      tags: data.tags,
      license: data.license,
      visibility: data.visibility,
      mainFile: data.mainFile,
      snapshot: templateSnapshotSchema.parse(snapshot),
    });
    return { id: templateId };
  });
}

export async function openTemplate({
  db,
  bucket,
  userId,
  data,
}: Context & { userId: string; data: z.infer<typeof openTemplateSchema> }) {
  data = openTemplateSchema.parse(data);
  return db.transaction(async (tx) => {
    const [source] = await tx
      .select()
      .from(template)
      .where(
        and(eq(template.id, data.templateId), eq(template.status, "approved")),
      )
      .for("share");
    if (!source) throw new Error("Template not found");
    if (data.organizationId) {
      const [membership] = await tx
        .select()
        .from(member)
        .where(
          and(
            eq(member.userId, userId),
            eq(member.organizationId, data.organizationId),
          ),
        )
        .for("share");
      if (!membership) throw new Error("Organization not found");
    }
    const projectId = crypto.randomUUID();
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`,
    );
    const snapshot = templateSnapshotSchema.parse(source.snapshot);
    assertProjectSourcePaths(snapshot);
    const ids = new Map(snapshot.map((node) => [node.id, crypto.randomUUID()]));
    await tx.insert(project).values({
      id: projectId,
      ownerId: data.organizationId ? null : userId,
      organizationId: data.organizationId,
      name: `${source.title} (${projectId})`,
    });
    const copied = [];
    for (const node of snapshot) {
      const id = ids.get(node.id);
      const parentId = node.parentId ? ids.get(node.parentId) : null;
      if (!id || parentId === undefined)
        throw new Error("Invalid template tree");
      copied.push({
        id,
        projectId,
        parentId,
        name: node.name,
        kind: node.kind,
        sizeBytes: BigInt(node.sizeBytes),
        objectKey:
          node.kind === "folder"
            ? null
            : await copyObject({
                bucket,
                from: node.objectKey,
                to: `projects/${projectId}/sources`,
                sizeBytes: node.sizeBytes,
              }),
      });
    }
    await tx.insert(projectNode).values(copied);
    return { id: projectId };
  });
}

export async function templateArchive({
  bucket,
  found,
}: {
  bucket: SourceBucket;
  found: StoredTemplate;
}) {
  const snapshot = templateSnapshotSchema.parse(found.snapshot);
  const paths = projectPaths(snapshot);
  const files: { path: string; blob: Blob }[] = [];
  for (const node of snapshot) {
    const path = paths.get(node.id);
    if (!path) continue;
    const object = node.objectKey ? await bucket.get(node.objectKey) : null;
    if (!object) throw new Error("Snapshot source is missing from storage");
    files.push({ path, blob: new Blob([await object.arrayBuffer()]) });
  }
  return createZip(files);
}

export async function reportTemplate({
  db,
  userId,
  templateId,
  reason,
}: {
  db: Db;
  userId: string;
  templateId: string;
  reason: string;
}) {
  const [found] = await db
    .select({ id: template.id })
    .from(template)
    .where(and(eq(template.id, templateId), eq(template.status, "approved")));
  if (!found) throw new Error("Template not found");
  await db
    .insert(templateReport)
    .values({ templateId, reporterId: userId, reason })
    .onConflictDoNothing();
}

function ensureReviewer(userId: string, reviewers: string) {
  if (!isTemplateReviewer(userId, reviewers))
    throw new Error("Not authorized to review templates");
}

export async function templateReviewQueue({
  db,
  userId,
  reviewers,
}: {
  db: Db;
  userId: string;
  reviewers: string;
}) {
  ensureReviewer(userId, reviewers);
  const pending = await db
    .select(publicColumns)
    .from(template)
    .where(eq(template.status, "pending"))
    .orderBy(template.createdAt)
    .limit(100);
  const reports = await db
    .select({
      id: templateReport.id,
      templateId: template.id,
      title: template.title,
      reason: templateReport.reason,
      createdAt: templateReport.createdAt,
    })
    .from(templateReport)
    .innerJoin(template, eq(template.id, templateReport.templateId))
    .where(isNull(templateReport.resolvedAt))
    .orderBy(templateReport.createdAt)
    .limit(100);
  return { pending, reports };
}

export async function reviewTemplate({
  db,
  userId,
  reviewers,
  templateId,
  decision,
}: {
  db: Db;
  userId: string;
  reviewers: string;
  templateId: string;
  decision: "approved" | "rejected";
}) {
  ensureReviewer(userId, reviewers);
  await db.transaction(async (tx) => {
    const [found] = await tx
      .select()
      .from(template)
      .where(eq(template.id, templateId))
      .for("update");
    if (
      !found ||
      !found.previewKey ||
      found.status === "building" ||
      found.status === "failed"
    )
      throw new Error("Template is not ready for review");
    if (found.ownerId === userId)
      throw new Error("Another reviewer must review your template");
    await tx
      .update(template)
      .set({ status: decision })
      .where(eq(template.id, templateId));
    await tx
      .update(templateReport)
      .set({ resolvedAt: new Date() })
      .where(eq(templateReport.templateId, templateId));
  });
}

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

export async function refreshTemplatePreviews({
  db,
  bucket,
  compiler,
  templateId,
}: Context & { compiler?: Pick<Fetcher, "fetch">; templateId?: string }) {
  const building = await db
    .select()
    .from(template)
    .where(
      and(
        eq(template.status, "building"),
        templateId ? eq(template.id, templateId) : undefined,
      ),
    )
    .orderBy(
      sql`${template.previewCheckedAt} asc nulls first`,
      template.createdAt,
    )
    .limit(10);
  for (const found of building) {
    await db
      .update(template)
      .set({ previewCheckedAt: new Date() })
      .where(eq(template.id, found.id));
    try {
      if (Date.now() - found.createdAt.getTime() > 24 * 60 * 60_000)
        throw new TemplatePreviewError(
          "Preview generation expired. Publish a new snapshot to retry.",
        );
      let response = await fetchCompiler(
        `/jobs/${found.id}`,
        undefined,
        compiler,
      );
      if (response.status === 404) {
        response = await fetchCompiler(
          "/compile",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Compilation-Id": found.id,
              "X-Compile-User": found.ownerId,
              "X-Compile-Plan": "free",
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
          "Preview compilation failed. Check that the saved project compiles, then publish a new snapshot.",
        );
      if (result.status !== "succeeded") continue;
      const png = await fetchCompiler(
        `/compilations/${found.id}.png`,
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
      const previewKey = `templates/${found.id}/preview.png`;
      await bucket.put(previewKey, bytes, {
        httpMetadata: { contentType: "image/png" },
      });
      const [previous] = await db
        .select({ id: template.id })
        .from(template)
        .where(
          and(
            eq(template.ownerId, found.ownerId),
            eq(template.status, "approved"),
          ),
        )
        .limit(1);
      await db
        .update(template)
        .set({ previewKey, status: previous ? "approved" : "pending" })
        .where(and(eq(template.id, found.id), eq(template.status, "building")));
    } catch (error) {
      console.error("Template preview failed", { templateId: found.id, error });
      if (
        !(
          error instanceof TemplatePreviewError ||
          error instanceof InvalidSourcePathError
        )
      )
        continue;
      await db
        .update(template)
        .set({
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "Preview generation failed",
        })
        .where(and(eq(template.id, found.id), eq(template.status, "building")));
    }
  }
}

export async function collectTemplateObjects({
  db,
  bucket,
  olderThan = new Date(Date.now() - 60 * 60_000),
}: Context & { olderThan?: Date }) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: "templates/",
      cursor,
      limit: 100,
    });
    const ids = new Set(
      page.objects
        .filter((object) => object.uploaded < olderThan)
        .flatMap((object) => {
          const parsed = z.uuid().safeParse(object.key.split("/")[1]);
          return parsed.success ? [parsed.data] : [];
        }),
    );
    for (const templateId of ids)
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${templateId}, 0))`,
        );
        const [found] = await tx
          .select({ id: template.id })
          .from(template)
          .where(eq(template.id, templateId));
        if (!found) {
          const garbage = page.objects.filter(
            (object) =>
              object.uploaded < olderThan &&
              object.key.startsWith(`templates/${templateId}/`),
          );
          if (garbage.length)
            await bucket.delete(garbage.map((object) => object.key));
        }
      });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
