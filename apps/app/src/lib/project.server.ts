import { isOrgAdmin } from "@texfolia/auth/roles";
import { fetchCompiler } from "@texfolia/compile/server";
import type { Db } from "@texfolia/db";
import {
  member,
  project,
  projectNode,
  projectTag,
  tag,
  user,
} from "@texfolia/db/schema";
import { retireSources, type SourceBucket } from "@texfolia/storage/server";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import {
  cleanupDeletedCollaboration,
  type CollaborationCleanup,
} from "./collaboration/cleanup.server";
import { lockProject } from "./project-access.server";
import type {
  createProjectSchema,
  renameProjectSchema,
  projectTagsSchema,
  updateProjectFormattingSchema,
  updateProjectSpellingSchema,
} from "./project.schema";

type ProjectOwner = { db: Db; ownerId: string };

export async function updateProjectFormatting({
  db,
  ownerId,
  data,
}: ProjectOwner & { data: z.infer<typeof updateProjectFormattingSchema> }) {
  return db.transaction(async (tx) => {
    await lockProject({
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
  data,
}: ProjectOwner & { data: z.infer<typeof updateProjectSpellingSchema> }) {
  return db.transaction(async (tx) => {
    await lockProject({
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

export async function createProject({
  db,
  ownerId,
  data,
}: ProjectOwner & { data: z.infer<typeof createProjectSchema> }) {
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
      canDelete: true,
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
      canDelete:
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
  data,
}: ProjectOwner & { data: z.infer<typeof renameProjectSchema> }) {
  await db.transaction(async (tx) => {
    await lockProject({ tx, projectId: data.projectId, userId: ownerId });
    await tx
      .update(project)
      .set({ name: data.name })
      .where(eq(project.id, data.projectId));
  });
}

export async function setProjectTags({
  db,
  ownerId,
  data,
}: ProjectOwner & { data: z.infer<typeof projectTagsSchema> }) {
  await db.transaction(async (tx) => {
    // Private labels serialize per user, including when that user labels different projects.
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, ownerId))
      .for("update");
    await lockProject({
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

export async function deleteProject({
  db,
  ownerId,
  projectId,
  collaboration,
}: ProjectOwner & { projectId: string; collaboration?: CollaborationCleanup }) {
  const deletedProject = await db.transaction(async (tx) => {
    const found = await lockProject({ tx, projectId, userId: ownerId });
    if (found.organizationId) {
      const [membership] = await tx
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, found.organizationId),
            eq(member.userId, ownerId),
          ),
        )
        .for("share");
      if (!membership || !isOrgAdmin(membership.role))
        throw new Error(
          "Only organization owners and admins can delete projects",
        );
    } else if (found.ownerId !== ownerId) throw new Error("Project not found");
    const sources = await tx
      .select({ key: projectNode.objectKey })
      .from(projectNode)
      .where(
        and(
          eq(projectNode.projectId, projectId),
          isNull(projectNode.deletedAt),
        ),
      );
    await retireSources(
      tx,
      projectId,
      sources.map((source) => source.key),
    );
    const [deleted] = await tx
      .update(project)
      .set({ deletedAt: new Date() })
      .where(and(eq(project.id, projectId), isNull(project.deletedAt)))
      .returning({ id: project.id });
    return deleted;
  });

  if (!deletedProject) throw new Error("Project not found");
  await cleanupDeletedCollaboration(collaboration, projectId);
  try {
    const response = await fetchCompiler(`/projects/${projectId}/build`, {
      method: "DELETE",
    });
    if (!response.ok)
      throw new Error(`Build cleanup returned ${response.status}`);
  } catch (error) {
    // The coordinator's retention alarm also removes artifacts if immediate cleanup is unavailable.
    console.error("Deleted project build cleanup failed", { projectId, error });
  }
  return deletedProject.id;
}

export async function getProject({
  db,
  ownerId,
  projectId,
  bucket,
}: ProjectOwner & { projectId: string; bucket?: SourceBucket }) {
  return db.transaction(async (tx) => {
    const { canWrite } = await lockProject({
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
    const sourceVersions: Record<
      string,
      { objectKey: string | null; updatedAt: number }
    > = {};
    const sourceContents: Record<string, string> = {};
    for (const node of result.nodes) {
      if (node.kind === "folder") continue;
      sourceVersions[node.id] = {
        objectKey: node.objectKey,
        updatedAt: node.updatedAt.getTime(),
      };
      if (node.kind === "text") {
        if (node.objectKey) {
          if (!bucket) throw new Error("Source storage unavailable");
          const object = await bucket.get(node.objectKey);
          if (!object) throw new Error("Saved source is missing from storage");
          sourceContents[node.id] = await object.text();
        } else sourceContents[node.id] = "";
      }
    }
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
  });
}
