import type { Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";

import type { createProjectSchema } from "./project.schema";

type ProjectOwner = { db: Db; ownerId: string };

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
  return db.query.project.findMany({
    with: {
      collaborators: {
        with: {
          user: true,
        },
      },
    },
    where: {
      ownerId,
      deletedAt: { isNull: true },
    },
  });
}

export async function deleteProject({
  db,
  ownerId,
  projectId,
}: ProjectOwner & { projectId: string }) {
  const [deletedProject] = await db
    .update(project)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(project.id, projectId),
        eq(project.ownerId, ownerId),
        isNull(project.deletedAt),
      ),
    )
    .returning({ id: project.id });

  if (!deletedProject) throw new Error("Project not found");
  return deletedProject.id;
}

export async function getProject({
  db,
  ownerId,
  projectId,
}: ProjectOwner & { projectId: string }) {
  const result = await db.query.project.findFirst({
    where: {
      id: projectId,
      ownerId,
      deletedAt: { isNull: true },
    },
    with: {
      nodes: {
        where: { deletedAt: { isNull: true } },
        columns: {
          id: true,
          projectId: true,
          parentId: true,
          name: true,
          kind: true,
        },
      },
    },
  });
  if (!result) throw new Error("Project not found");
  return result;
}
