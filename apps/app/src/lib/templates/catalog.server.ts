import type { Db } from "@texfolia/db";
import { member, organization, template } from "@texfolia/db/schema";
import {
  and,
  arrayContains,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";

import { isOrgAdmin } from "#/lib/auth/roles";
import { projectPaths } from "#/lib/projects";
import type { ProjectTransaction } from "#/lib/projects/server";
import type { SourceBucket } from "#/lib/storage/server";
import { zipStream, type ZipEntry } from "#/lib/storage/zip";

import { type listTemplatesSchema, templateSnapshotSchema } from "./schema";

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

/** Approved templates that their publisher has not hidden. */
export const availableTemplate = and(
  eq(template.status, "approved"),
  isNull(template.unpublishedAt),
);

type Audience = Pick<
  typeof template.$inferSelect,
  "status" | "unpublishedAt" | "visibility" | "ownerId" | "organizationId"
>;

/**
 * Whether the user may open, preview and download an available template.
 * Anyone may use a public or unlisted one. A private one is only for its owner,
 * or for the members of the organization it was published for.
 */
export async function usesTemplate(
  db: Db | ProjectTransaction,
  found: Audience,
  userId: string | undefined,
) {
  if (found.status !== "approved" || found.unpublishedAt) return false;
  if (found.visibility !== "private") return true;
  if (!userId) return false;
  if (!found.organizationId) return found.ownerId === userId;
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, found.organizationId),
        eq(member.userId, userId),
      ),
    );
  return !!membership;
}

/** The private templates that a user may use. */
function privateTo(userId: string, organizationIds: string[]) {
  return and(
    eq(template.visibility, "private"),
    or(
      and(eq(template.ownerId, userId), isNull(template.organizationId)),
      organizationIds.length
        ? inArray(template.organizationId, organizationIds)
        : undefined,
    ),
  );
}

// Every word must appear somewhere in the template.
function matchesSearch(q: string) {
  return and(
    ...q
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        const pattern = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
        return or(
          ilike(template.title, pattern),
          ilike(template.description, pattern),
          ilike(template.publisherName, pattern),
          sql`array_to_string(${template.tags}, ' ') ilike ${pattern}`,
        );
      }),
  );
}

export async function listTemplates({
  db,
  page = 0,
  q,
  tag,
  license,
}: { db: Db } & Partial<z.infer<typeof listTemplatesSchema>>) {
  return db
    .select(publicColumns)
    .from(template)
    .where(
      and(
        availableTemplate,
        eq(template.visibility, "public"),
        tag ? arrayContains(template.tags, [tag]) : undefined,
        license ? eq(template.license, license) : undefined,
        q ? matchesSearch(q) : undefined,
      ),
    )
    .orderBy(desc(template.createdAt), desc(template.id))
    .limit(24)
    .offset(page * 24);
}

/**
 * Whether the user may hide or delete a template: its publisher, or an owner or
 * admin of the organization it was published for.
 */
export async function managesTemplate(
  db: Db | ProjectTransaction,
  found: Pick<typeof template.$inferSelect, "ownerId" | "organizationId">,
  userId: string | undefined,
) {
  if (!userId) return false;
  if (!found.organizationId) return found.ownerId === userId;
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, found.organizationId),
        eq(member.userId, userId),
      ),
    );
  return !!membership && isOrgAdmin(membership.role);
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
  if (!found) return null;
  if (await usesTemplate(db, found, userId)) return found;
  if (!userId) return null;
  // Reviewers never see private templates, which skip review. A private
  // organization template stays with the organization's members.
  if (found.visibility === "private") {
    if (!found.organizationId && found.ownerId === userId) return found;
    return (await managesTemplate(db, found, userId)) ? found : null;
  }
  if (
    found.ownerId === userId ||
    isTemplateReviewer(userId, reviewers) ||
    (await managesTemplate(db, found, userId))
  )
    return found;
  return null;
}

/**
 * The available private templates a user may open, for the new-project picker.
 * They are never in {@link listTemplates}.
 */
export async function listPrivateTemplates({
  db,
  userId,
  page = 0,
  q,
}: { db: Db; userId: string } & Partial<
  Pick<z.infer<typeof listTemplatesSchema>, "page" | "q">
>) {
  const memberships = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId));
  return db
    .select(publicColumns)
    .from(template)
    .where(
      and(
        availableTemplate,
        privateTo(
          userId,
          memberships.map(({ organizationId }) => organizationId),
        ),
        q ? matchesSearch(q) : undefined,
      ),
    )
    .orderBy(desc(template.createdAt), desc(template.id))
    .limit(24)
    .offset(page * 24);
}

export async function listMyTemplates({
  db,
  userId,
}: {
  db: Db;
  userId: string;
}) {
  const memberships = await db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId));
  const managed = memberships.flatMap(({ organizationId, role }) =>
    isOrgAdmin(role) ? [organizationId] : [],
  );
  const joined = memberships.flatMap(({ organizationId, role }) =>
    isOrgAdmin(role) ? [] : [organizationId],
  );
  const rows = await db
    .select({
      ...publicColumns,
      organizationId: template.organizationId,
      unpublishedAt: template.unpublishedAt,
      rejectionReason: template.rejectionReason,
    })
    .from(template)
    .where(
      or(
        and(
          eq(template.ownerId, userId),
          // A private organization template stays with the organization.
          or(
            ne(template.visibility, "private"),
            isNull(template.organizationId),
          ),
        ),
        managed.length ? inArray(template.organizationId, managed) : undefined,
        // Plain members see their organizations' usable private templates.
        joined.length
          ? and(
              availableTemplate,
              eq(template.visibility, "private"),
              inArray(template.organizationId, joined),
            )
          : undefined,
      ),
    )
    .orderBy(desc(template.createdAt))
    .limit(100);
  return rows.map(({ organizationId, unpublishedAt, ...row }) => ({
    ...row,
    published: !unpublishedAt,
    canManage: !organizationId || managed.includes(organizationId),
  }));
}

export async function getTemplate(options: Parameters<typeof findTemplate>[0]) {
  const found = await findTemplate(options);
  if (!found) return null;
  const reviews =
    !!options.userId &&
    isTemplateReviewer(options.userId, options.reviewers ?? "");
  const canManage = await managesTemplate(options.db, found, options.userId);
  const involved = canManage || reviews || found.ownerId === options.userId;
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
    published: !found.unpublishedAt,
    /** Whether it was published for an organization. */
    forOrganization: !!found.organizationId,
    /** Whether the viewer may hide or delete it. */
    canManage,
    canRetryPreview: reviews || found.ownerId === options.userId,
    error: involved ? found.error : null,
    rejectionReason: involved ? found.rejectionReason : null,
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

// Streams a template's sources, reading one at a time from storage.
export function templateArchive({
  bucket,
  found,
}: {
  bucket: SourceBucket;
  found: typeof template.$inferSelect;
}) {
  const snapshot = templateSnapshotSchema.parse(found.snapshot);
  const paths = projectPaths(snapshot);
  const entries: ZipEntry[] = [];
  for (const { id, objectKey } of snapshot) {
    const path = paths.get(id);
    if (!path) continue;
    entries.push({
      path,
      async open() {
        const object = objectKey ? await bucket.get(objectKey) : null;
        if (!object) throw new Error("Snapshot source is missing from storage");
        return new Uint8Array(await object.arrayBuffer());
      },
    });
  }
  return zipStream(entries);
}
