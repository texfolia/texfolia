import type { Db } from "@texfolia/db";
import {
  project,
  projectNode,
  projectTag,
  tag,
  user,
} from "@texfolia/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import { isOrgAdmin } from "#/lib/auth/roles";
import { mapLimit } from "#/lib/map-limit";
import { sourceConcurrency, type SourceBucket } from "#/lib/storage/server";

import type { LockProject } from "./access";
import { projectPaths } from "./paths";
import type {
  createProjectSchema,
  renameProjectSchema,
  projectTagsSchema,
  updateProjectFormattingSchema,
  updateProjectMainFileSchema,
  updateProjectSpellingSchema,
} from "./project.schema";

// `lock` is the app's composed access check (see `projectLock`).
type ProjectOwner = { db: Db; ownerId: string; lock: LockProject };

export async function updateProjectFormatting({
  db,
  ownerId,
  lock,
  data,
}: ProjectOwner & { data: z.infer<typeof updateProjectFormattingSchema> }) {
  return db.transaction(async (tx) => {
    await lock({
      tx,
      projectId: data.projectId,
      userId: ownerId,
      access: "write",
    });
    await tx
      .update(project)
      .set({
        formatIndent: data.formatting.indent,
        formatWrap: data.formatting.wrap,
        formatWidth: data.formatting.width,
      })
      .where(eq(project.id, data.projectId));
    return data.formatting;
  });
}

export async function updateProjectSpelling({
  db,
  ownerId,
  lock,
  data,
}: ProjectOwner & { data: z.infer<typeof updateProjectSpellingSchema> }) {
  return db.transaction(async (tx) => {
    await lock({
      tx,
      projectId: data.projectId,
      userId: ownerId,
      access: "write",
    });
    await tx
      .update(project)
      .set({ spellcheckLanguage: data.language })
      .where(eq(project.id, data.projectId));
    return data.language;
  });
}

export async function updateProjectMainFile({
  db,
  ownerId,
  lock,
  data,
}: ProjectOwner & { data: z.infer<typeof updateProjectMainFileSchema> }) {
  const { projectId, mainFile } = data;
  return db.transaction(async (tx) => {
    await lock({ tx, projectId, userId: ownerId, access: "write" });
    if (mainFile !== null) {
      const nodes = await tx.query.projectNode.findMany({
        where: { projectId, deletedAt: { isNull: true } },
      });
      if (![...projectPaths(nodes).values()].includes(mainFile))
        throw new Error("File not found");
    }
    await tx.update(project).set({ mainFile }).where(eq(project.id, projectId));
    return mainFile;
  });
}

export async function createProject({
  db,
  ownerId,
  data,
}: Omit<ProjectOwner, "lock"> & { data: z.infer<typeof createProjectSchema> }) {
  return db.transaction(async (tx) => {
    const [newProject] = await tx
      .insert(project)
      .values({
        id: data.id,
        ownerId,
        name: data.name,
      })
      .returning();

    if (!newProject) {
      tx.rollback();
      throw new Error("Failed to create project");
    }

    const [newNode] = await tx
      .insert(projectNode)
      .values({
        projectId: newProject.id,
        name: data.name,
        kind: "folder",
        sizeBytes: 0n,
      })
      .returning();

    if (!newNode) {
      tx.rollback();
      throw new Error("Failed to create node");
    }

    await tx.insert(projectNode).values({
      projectId: newProject.id,
      parentId: newNode.id,
      name: "main.tex",
      kind: "text",
      sizeBytes: 0n,
    });

    const owner = await tx.query.user.findFirst({
      where: { id: ownerId },
      columns: { id: true, name: true, image: true },
    });
    return {
      ...newProject,
      collaborators: [],
      owner: owner ?? null,
      people: owner ? [{ ...owner, role: "owner" }] : [],
      tags: [],
      canWrite: true,
      canManage: true,
    };
  });
}

export const projectPageSize = 100;
export const maxProjectPageSize = 200;

// Projects the viewer may open: live personal projects they own or collaborate
// on, plus every live project in an organization they belong to. Relation
// filters compile to EXISTS subqueries, so access costs no extra round trip.
type ProjectFilter = Extract<
  NonNullable<Parameters<Db["query"]["project"]["findMany"]>[0]>["where"],
  object
>;

export function accessibleProjects(userId: string): ProjectFilter {
  return {
    deletedAt: { isNull: true },
    OR: [
      {
        organizationId: { isNull: true },
        OR: [{ ownerId: userId }, { collaborators: { userId } }],
      },
      { organization: { members: { userId } } },
    ],
  };
}

// One relational query: access, tags, people, and the viewer's organization
// role all load together. Most recently updated first. The cursor is the last
// project ID of the previous page; comparing against that row's stored
// timestamp keeps the microsecond precision a JS Date would lose.
export async function getProjects({
  db,
  userId,
  limit = projectPageSize,
  cursor,
}: {
  db: Db;
  userId: string;
  limit?: number;
  cursor?: string;
}) {
  const take = Math.min(Math.max(Math.trunc(limit), 1), maxProjectPageSize);
  const rows = await db.query.project.findMany({
    with: {
      owner: { columns: { id: true, name: true, image: true } },
      collaborators: {
        with: {
          user: { columns: { id: true, name: true, image: true } },
        },
      },
      // Tags are private to each user, so only the viewer's catalog applies.
      tags: { columns: { name: true }, where: { userId } },
      organization: {
        columns: { id: true },
        with: {
          members: {
            columns: { userId: true, role: true },
            with: { user: { columns: { id: true, name: true, image: true } } },
          },
        },
      },
    },
    where: {
      AND: [
        accessibleProjects(userId),
        cursor
          ? {
              RAW: (table) => sql`(${table.updatedAt}, ${table.id}) < (
          select ${project.updatedAt}, ${project.id}
          from ${project}
          where ${project.id} = ${cursor}
        )`,
            }
          : {},
      ],
    },
    orderBy: { updatedAt: "desc", id: "desc" },
    limit: take + 1,
  });

  const page = rows.slice(0, take);
  return {
    projects: page.map(({ tags, organization, ...row }) => ({
      ...row,
      tags: tags.map((item) => item.name).sort(),
      people: organization
        ? organization.members.flatMap((person) =>
            person.user ? [{ ...person.user, role: person.role }] : [],
          )
        : [
            ...(row.owner ? [{ ...row.owner, role: "owner" }] : []),
            ...row.collaborators.flatMap((person) =>
              person.user ? [{ ...person.user, role: person.role }] : [],
            ),
          ],
      canWrite:
        !!organization ||
        row.ownerId === userId ||
        row.collaborators.some(
          (person) => person.userId === userId && person.role === "editor",
        ),
      canManage:
        row.ownerId === userId ||
        !!organization?.members.some(
          (person) => person.userId === userId && isOrgAdmin(person.role),
        ),
    })),
    nextCursor: rows.length > take ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function renameProject({
  db,
  ownerId,
  lock,
  data,
}: ProjectOwner & { data: z.infer<typeof renameProjectSchema> }) {
  await db.transaction(async (tx) => {
    await lock({ tx, projectId: data.projectId, userId: ownerId });
    await tx
      .update(project)
      .set({ name: data.name })
      .where(eq(project.id, data.projectId));
  });
}

export async function setProjectTags({
  db,
  ownerId,
  lock,
  data,
}: ProjectOwner & { data: z.infer<typeof projectTagsSchema> }) {
  await db.transaction(async (tx) => {
    // Private labels serialize per user, including when that user labels different projects.
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, ownerId))
      .for("update");
    await lock({
      tx,
      projectId: data.projectId,
      userId: ownerId,
      access: "read",
    });
    const ownTags = await tx
      .select({ id: tag.id })
      .from(tag)
      .where(eq(tag.userId, ownerId));
    if (ownTags.length)
      await tx.delete(projectTag).where(
        and(
          eq(projectTag.projectId, data.projectId),
          inArray(
            projectTag.tagId,
            ownTags.map((item) => item.id),
          ),
        ),
      );
    if (!data.tags.length) return;
    await tx
      .insert(tag)
      .values(data.tags.map((name) => ({ userId: ownerId, name })))
      .onConflictDoNothing();
    const selected = await tx
      .select({ id: tag.id })
      .from(tag)
      .where(and(eq(tag.userId, ownerId), inArray(tag.name, data.tags)));
    await tx
      .insert(projectTag)
      .values(
        selected.map((item) => ({ projectId: data.projectId, tagId: item.id })),
      );
  });
}

export async function getProject({
  db,
  ownerId,
  lock,
  projectId,
  bucket,
}: ProjectOwner & { projectId: string; bucket?: SourceBucket }) {
  const { result, canWrite } = await db.transaction(async (tx) => {
    const { canWrite } = await lock({
      tx,
      projectId,
      userId: ownerId,
      access: "read",
    });
    const result = await tx.query.project.findFirst({
      where: {
        id: projectId,
        deletedAt: { isNull: true },
      },
      with: {
        nodes: {
          where: { deletedAt: { isNull: true } },
        },
      },
    });
    if (!result) throw new Error("Project not found");
    return { result, canWrite };
  });
  const sourceVersions: Record<
    string,
    { objectKey: string | null; updatedAt: number }
  > = {};
  for (const node of result.nodes)
    if (node.kind !== "folder")
      sourceVersions[node.id] = {
        objectKey: node.objectKey,
        updatedAt: node.updatedAt.getTime(),
      };
  const sourceContents = Object.fromEntries(
    await mapLimit(
      result.nodes.filter((node) => node.kind === "text"),
      sourceConcurrency,
      async ({ id, objectKey }) => {
        if (!objectKey) return [id, ""] as const;
        if (!bucket) throw new Error("Source storage unavailable");
        const object = await bucket.get(objectKey);
        if (!object) throw new Error("Saved source is missing from storage");
        return [id, await object.text()] as const;
      },
    ),
  );
  return {
    ...result,
    nodes: result.nodes.map(({ id, projectId, parentId, name, kind }) => ({
      id,
      projectId,
      parentId,
      name,
      kind,
    })),
    canWrite,
    sourceVersions,
    sourceContents,
  };
}
