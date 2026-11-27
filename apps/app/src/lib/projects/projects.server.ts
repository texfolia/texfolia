import type { Db } from "@texfolia/db";
import {
  member,
  project,
  projectCollaborator,
  projectNode,
  projectShareGrant,
  projectTag,
  projectTeam,
  tag,
  teamMember,
  user,
} from "@texfolia/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import { isOrgAdmin } from "#/lib/auth/roles";
import type { SourceBucket } from "#/lib/storage/server";

import type { LockProject, ProjectTransaction } from "./access";
import { projectMainFile } from "./main-file";
import { projectPaths } from "./paths";
import type {
  createProjectSchema,
  renameProjectSchema,
  projectTagsSchema,
  updateProjectFormattingSchema,
  updateProjectMainFileSchema,
  updateProjectSpellingSchema,
} from "./project.schema";
import { projectPermissions, strongerRole, type ProjectRole } from "./roles";

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
      ...projectPermissions("editor"),
      canManage: true,
    };
  });
}

export const projectPageSize = 100;
export const maxProjectPageSize = 200;

// Projects the viewer may open: live personal projects they own or collaborate
// on; organization projects open to every member, or shared with them or one
// of their teams, or any project when they manage the organization; and any
// project whose share link they redeemed. Mirrors `lockProject`. The filter
// compiles to EXISTS subqueries, so access costs no extra round trip.
type ProjectFilter = Extract<
  NonNullable<Parameters<Db["query"]["project"]["findMany"]>[0]>["where"],
  object
>;

export function accessibleProjects(userId: string): ProjectFilter {
  return {
    deletedAt: { isNull: true },
    RAW: (t) => sql`(
      (${t.organizationId} is null and (
        ${t.ownerId} = ${userId}
        or exists (select 1 from ${projectCollaborator} where ${projectCollaborator.projectId} = ${t.id} and ${projectCollaborator.userId} = ${userId})
      ))
      or exists (
        select 1 from ${member}
        where ${member.organizationId} = ${t.organizationId} and ${member.userId} = ${userId}
        and (
          ${t.organizationRole} is not null
          or ${member.role} ~ '(^|,)\\s*(owner|admin)\\s*(,|$)'
          or exists (select 1 from ${projectCollaborator} where ${projectCollaborator.projectId} = ${t.id} and ${projectCollaborator.userId} = ${userId})
          or exists (
            select 1 from ${projectTeam}
            inner join ${teamMember} on ${teamMember.teamId} = ${projectTeam.teamId}
            where ${projectTeam.projectId} = ${t.id} and ${teamMember.userId} = ${userId}
          )
        )
      )
      or exists (select 1 from ${projectShareGrant} where ${projectShareGrant.projectId} = ${t.id} and ${projectShareGrant.userId} = ${userId})
    )`,
  };
}

// The strongest role among the grants `getProjects` loads, as `lockProject`
// computes it.
function viewerRole(
  row: {
    ownerId: string | null;
    organizationId: string | null;
    organizationRole: ProjectRole | null;
    collaborators: { userId: string; role: ProjectRole }[];
    shareGrants: { link: { role: ProjectRole } | null }[];
    teams: { role: ProjectRole }[];
  },
  members: { userId: string; role: string }[] | undefined,
  userId: string,
): ProjectRole {
  let role: ProjectRole | null = null;
  for (const grant of row.shareGrants)
    role = strongerRole(role, grant.link?.role ?? null);
  if (!row.organizationId) {
    if (row.ownerId === userId) return "editor";
  } else {
    const membership = members?.find((person) => person.userId === userId);
    if (!membership) return role ?? "viewer";
    if (isOrgAdmin(membership.role)) return "editor";
    role = strongerRole(role, row.organizationRole);
    for (const team of row.teams) role = strongerRole(role, team.role);
  }
  for (const person of row.collaborators)
    if (person.userId === userId) role = strongerRole(role, person.role);
  return role ?? "viewer";
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
      // Only the viewer's own grants decide their role.
      shareGrants: {
        columns: { userId: true },
        where: { userId },
        with: { link: { columns: { role: true } } },
      },
      teams: {
        columns: { role: true },
        where: { team: { teamMembers: { userId } } },
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
    projects: page.map(
      ({ tags, organization, shareGrants, teams, ...row }) => ({
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
        ...projectPermissions(
          viewerRole(
            { ...row, shareGrants, teams },
            organization?.members,
            userId,
          ),
        ),
        canManage:
          row.ownerId === userId ||
          !!organization?.members.some(
            (person) => person.userId === userId && isOrgAdmin(person.role),
          ),
      }),
    ),
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

export async function getProject<
  Extra extends Record<string, unknown> = Record<never, never>,
>({
  db,
  ownerId,
  lock,
  projectId,
  bucket,
  extra,
}: ProjectOwner & {
  projectId: string;
  bucket?: SourceBucket;
  extra?: (
    tx: ProjectTransaction,
    permissions: {
      role: ProjectRole;
      canWrite: boolean;
      canComment: boolean;
    },
  ) => Promise<Extra>;
}) {
  const { result, permissions, extras } = await db.transaction(async (tx) => {
    const { role, canWrite, canComment } = await lock({
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
    const permissions = { role, canWrite, canComment };
    const extras = extra ? await extra(tx, permissions) : ({} as Extra);
    return { result, permissions, extras };
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
  // Only preload the main text file on open; other files load on demand.
  const main = projectMainFile(projectPaths(result.nodes), result.mainFile);
  const mainNode = main
    ? result.nodes.find((node) => node.id === main.id && node.kind === "text")
    : undefined;
  const sourceContents: Record<string, string> = {};
  if (mainNode) {
    if (!mainNode.objectKey) {
      sourceContents[mainNode.id] = "";
    } else if (bucket) {
      const object = await bucket.get(mainNode.objectKey);
      if (!object) throw new Error("Saved source is missing from storage");
      sourceContents[mainNode.id] = await object.text();
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
    ...permissions,
    sourceVersions,
    sourceContents,
    ...extras,
  };
}
