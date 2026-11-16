import type { Db } from "@texfolia/db";
import {
  member,
  project,
  projectCollaborator,
  projectNode,
} from "@texfolia/db/schema";
import { and, eq, isNull, or, inArray } from "drizzle-orm";
import type { z } from "zod";

import {
  cleanupDeletedCollaboration,
  type CollaborationCleanup,
} from "./collaboration/cleanup.server";
import { fetchCompiler } from "./compiler.server";
import { lockProject } from "./project-access.server";
import type { SourceBucket } from "./project-source.server";
import type {
  createProjectSchema,
  updateProjectFormattingSchema,
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

    return { ...newProject, collaborators: [] };
  });
}

export async function getProjects({ db, ownerId }: ProjectOwner) {
  const memberships = await db
    .select({ id: member.organizationId })
    .from(member)
    .where(eq(member.userId, ownerId));
  const accessible = await db
    .select({ id: project.id })
    .from(project)
    .where(
      and(
        isNull(project.deletedAt),
        or(
          and(
            isNull(project.organizationId),
            or(
              eq(project.ownerId, ownerId),
              inArray(
                project.id,
                db
                  .select({ id: projectCollaborator.projectId })
                  .from(projectCollaborator)
                  .where(eq(projectCollaborator.userId, ownerId)),
              ),
            ),
          ),
          memberships.length
            ? inArray(
                project.organizationId,
                memberships.map((item) => item.id),
              )
            : undefined,
        ),
      ),
    );
  if (!accessible.length) return [];
  return db.query.project.findMany({
    with: {
      collaborators: {
        with: {
          user: true,
        },
      },
    },
    where: {
      id: { in: accessible.map((item) => item.id) },
      deletedAt: { isNull: true },
    },
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
      if (
        !membership?.role
          .split(",")
          .some((role) => role === "owner" || role === "admin")
      )
        throw new Error(
          "Only organization owners and admins can delete projects",
        );
    } else if (found.ownerId !== ownerId) throw new Error("Project not found");
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
