import type { Db } from "@texfolia/db";
import {
  member,
  organization,
  project,
  projectNode,
  template,
  templatePublication,
  user,
} from "@texfolia/db/schema";
import { and, eq, gte, lt } from "drizzle-orm";
import type { z } from "zod";

import { isOrgAdmin } from "#/lib/auth/roles";
import { mapLimit } from "#/lib/map-limit";
import { assertProjectSourcePaths, projectPaths } from "#/lib/projects";
import { availableProjectName, type LockProject } from "#/lib/projects/server";
import {
  copySource,
  sourceConcurrency,
  type SourceBucket,
  type SourceTransaction,
} from "#/lib/storage/server";

import { availableTemplate } from "./catalog.server";
import {
  openTemplateSchema,
  publishTemplateSchema,
  templateSnapshotSchema,
} from "./schema";

type Context = { db: Db; bucket: SourceBucket };
type Snapshot = z.infer<typeof templateSnapshotSchema>;

// Copies a tree's files. Several nodes may share an object, which is copied once.
async function copySources(
  bucket: SourceBucket,
  nodes: readonly Pick<Snapshot[number], "kind" | "objectKey" | "sizeBytes">[],
  to: string,
) {
  const files = new Map(
    nodes.flatMap((node) =>
      node.kind === "folder" ? [] : [[node.objectKey, node.sizeBytes] as const],
    ),
  );
  return new Map(
    await mapLimit(
      [...files],
      sourceConcurrency,
      async ([from, sizeBytes]) =>
        [from, await copySource({ bucket, from, to, sizeBytes })] as const,
    ),
  );
}

type Publication = {
  userId: string;
  data: z.infer<typeof publishTemplateSchema>;
  templateId: string;
};

// The publishing limits count publications since then.
function limitStart() {
  return new Date(Date.now() - 24 * 60 * 60_000);
}

// Checks the publisher, their limits, and their access to the project. The
// user's row lock serializes the limits.
async function checkPublication(
  tx: SourceTransaction,
  {
    lock,
    userId,
    data,
    templateId,
  }: Publication & {
    lock: LockProject;
  },
) {
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
    return null;
  }
  const recent = await tx
    .select({ createdAt: templatePublication.createdAt })
    .from(templatePublication)
    .where(
      and(
        eq(templatePublication.userId, userId),
        gte(templatePublication.createdAt, limitStart()),
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
  const source = await lock({
    tx,
    projectId: data.projectId,
    userId,
    access: "read",
  });
  if (!source.organizationId) {
    if (source.ownerId !== userId)
      throw new Error("Only the project owner can publish templates");
    return { organizationId: null, publisherName: publisher.name };
  }
  const { organizationId } = source;
  const [membership] = await tx
    .select()
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
    )
    .for("share");
  if (!membership || !isOrgAdmin(membership.role))
    throw new Error(
      "Only organization owners and admins can publish templates",
    );
  const [org] = await tx
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId));
  if (!org) throw new Error("Organization not found");
  return { organizationId, publisherName: org.name };
}

export async function publishTemplate({
  db,
  bucket,
  lock,
  userId,
  data,
  templateId = crypto.randomUUID(),
}: Context &
  Omit<Publication, "templateId"> & {
    lock: LockProject;
    templateId?: string;
  }) {
  data = publishTemplateSchema.parse(data);
  const publication = { lock, userId, data, templateId };
  const nodes = await db.transaction(async (tx) => {
    if (!(await checkPublication(tx, publication))) return null;
    return tx.query.projectNode.findMany({
      where: { projectId: data.projectId, deletedAt: { isNull: true } },
    });
  });
  if (!nodes) return { id: templateId };
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
  const sources = nodes.map((node) => ({
    id: node.id,
    parentId: node.parentId,
    name: node.name,
    kind: node.kind,
    sizeBytes: Number(node.sizeBytes),
    objectKey: node.objectKey,
  }));
  // Collection leaves recent uploads alone until the template refers to them.
  const keys = await copySources(
    bucket,
    sources,
    `templates/${templateId}/sources`,
  );
  const snapshot: Snapshot = sources.map((node) => ({
    ...node,
    objectKey:
      node.kind === "folder" ? null : (keys.get(node.objectKey) ?? null),
  }));
  return db.transaction(async (tx) => {
    const publisher = await checkPublication(tx, publication);
    if (publisher) {
      await tx
        .delete(templatePublication)
        .where(
          and(
            eq(templatePublication.userId, userId),
            lt(templatePublication.createdAt, limitStart()),
          ),
        );
      await tx.insert(templatePublication).values({ templateId, userId });
      await tx.insert(template).values({
        id: templateId,
        ownerId: userId,
        ...publisher,
        title: data.title,
        description: data.description,
        tags: data.tags,
        license: data.license,
        visibility: data.visibility,
        mainFile: data.mainFile,
        snapshot: templateSnapshotSchema.parse(snapshot),
      });
    }
    return { id: templateId };
  });
}

// Finds an approved template and checks that the user may create projects there.
async function checkOpening(
  tx: SourceTransaction,
  {
    userId,
    data,
  }: { userId: string; data: z.infer<typeof openTemplateSchema> },
) {
  const [owner] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .for("update");
  if (!owner) throw new Error("Unauthorized");
  const [source] = await tx
    .select()
    .from(template)
    .where(and(eq(template.id, data.templateId), availableTemplate))
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
  return source;
}

export async function openTemplate({
  db,
  bucket,
  userId,
  data,
}: Context & { userId: string; data: z.infer<typeof openTemplateSchema> }) {
  data = openTemplateSchema.parse(data);
  const request = { userId, data };
  // A template's snapshot never changes.
  const source = await db.transaction((tx) => checkOpening(tx, request));
  const snapshot = templateSnapshotSchema.parse(source.snapshot);
  assertProjectSourcePaths(snapshot);
  const projectId = crypto.randomUUID();
  const ids = new Map(snapshot.map((node) => [node.id, crypto.randomUUID()]));
  const keys = await copySources(
    bucket,
    snapshot,
    `projects/${projectId}/sources`,
  );
  const copied = snapshot.map((node) => {
    const id = ids.get(node.id);
    const parentId = node.parentId ? ids.get(node.parentId) : null;
    if (!id || parentId === undefined) throw new Error("Invalid template tree");
    return {
      id,
      projectId,
      parentId,
      name: node.name,
      kind: node.kind,
      sizeBytes: BigInt(node.sizeBytes),
      objectKey:
        node.kind === "folder" ? null : (keys.get(node.objectKey) ?? null),
    };
  });
  return db.transaction(async (tx) => {
    await checkOpening(tx, request);
    const name = await availableProjectName(
      tx,
      data.organizationId
        ? { organizationId: data.organizationId }
        : { ownerId: userId },
      data.name ?? source.title,
    );
    await tx.insert(project).values({
      id: projectId,
      ownerId: data.organizationId ? null : userId,
      organizationId: data.organizationId,
      name,
      mainFile: source.mainFile,
    });
    await tx.insert(projectNode).values(copied);
    return { id: projectId };
  });
}
