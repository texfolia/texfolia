import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectNode,
  template,
  user,
} from "@texfolia/db/schema";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { z } from "zod";

import { hashSource } from "./latex/source-sync";
import { lockProject } from "./project-access.server";
import { assertProjectSourcePaths, projectPaths } from "./project-paths";
import type { SourceBucket } from "./project-source.server";
import {
  openTemplateSchema,
  publishTemplateSchema,
  templateSnapshotSchema,
} from "./template.schema";

type Context = { db: Db; bucket: SourceBucket };
type Snapshot = z.infer<typeof templateSnapshotSchema>;
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
    const [owner] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");
    if (!owner) throw new Error("Unauthorized");
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
    const names = new Set(
      (
        await tx
          .select({ name: project.name })
          .from(project)
          .where(
            and(
              data.organizationId
                ? eq(project.organizationId, data.organizationId)
                : eq(project.ownerId, userId),
              isNull(project.deletedAt),
            ),
          )
      ).map((row) => row.name),
    );
    let name = source.title;
    for (let suffix = 2; names.has(name); suffix++)
      name = `${source.title} (${suffix})`;
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
      name,
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
