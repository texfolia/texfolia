import type { Db } from "@texfolia/db";
import { member, organization, template } from "@texfolia/db/schema";
import type { SourceBucket } from "@texfolia/storage/server";
import { createZip } from "@texfolia/storage/zip";
import { and, desc, eq } from "drizzle-orm";

import { projectPaths } from "./project-paths";
import { templateSnapshotSchema } from "./template.schema";

export const publicColumns = {
  id: template.id,
  title: template.title,
  description: template.description,
  tags: template.tags,
  license: template.license,
  visibility: template.visibility,
  publisherName: template.publisherName,
  createdAt: template.createdAt,
  status: template.status,
  previewStatus: template.previewStatus,
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
    previewStatus: found.previewStatus,
    canManage:
      found.ownerId === options.userId ||
      !!(
        options.userId &&
        isTemplateReviewer(options.userId, options.reviewers ?? "")
      ),
    error:
      found.ownerId === options.userId ||
      (options.userId &&
        isTemplateReviewer(options.userId, options.reviewers ?? ""))
        ? found.error
        : null,
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

export async function templateArchive({
  bucket,
  found,
}: {
  bucket: SourceBucket;
  found: typeof template.$inferSelect;
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
