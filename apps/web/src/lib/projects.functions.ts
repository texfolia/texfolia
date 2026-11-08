import { createServerFn } from "@tanstack/react-start";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import z from "zod";

import { ensureSession } from "./auth.functions";

export const createProject = createServerFn({ method: "POST" })
  .validator(
    z.object({
      name: z.string().trim().min(1),
    }),
  )
  .handler(async ({ data, context }) => {
    const session = await ensureSession();

    return context.db.transaction(async (tx) => {
      const [newProject] = await tx
        .insert(project)
        .values({
          ownerId: session.user.id,
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

      return newProject.id;
    });
  });

export const getProjects = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();

    return context.db.query.project.findMany({
      with: {
        collaborators: {
          with: {
            user: true,
          },
        },
      },
      where: {
        ownerId: session.user.id,
        deletedAt: { isNull: true },
      },
    });
  },
);

export type GetProjectsResult = Awaited<ReturnType<typeof getProjects>>;

export const deleteProject = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const [deletedProject] = await context.db
      .update(project)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(project.id, data.projectId),
          eq(project.ownerId, session.user.id),
          isNull(project.deletedAt),
        ),
      )
      .returning({ id: project.id });

    if (!deletedProject) throw new Error("Project not found");
    return deletedProject.id;
  });

export const getProject = createServerFn({ method: "GET" })
  .validator(z.object({ projectId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const result = await context.db.query.project.findFirst({
      where: {
        id: data.projectId,
        ownerId: session.user.id,
        deletedAt: { isNull: true },
      },
      with: {
        nodes: {
          where: { deletedAt: { isNull: true } },
          columns: { id: true, parentId: true, name: true, kind: true },
        },
      },
    });
    if (!result) throw new Error("Project not found");
    return result;
  });
