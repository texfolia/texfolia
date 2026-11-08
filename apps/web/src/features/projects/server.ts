import { createServerFn } from "@tanstack/react-start";
import { project, projectNode } from "@texfolia/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import z from "zod";

import {
  createNodeSchema,
  createProjectSchema,
} from "#/features/projects/schema";
import { ensureSession } from "#/lib/auth.functions";

export const createProject = createServerFn({ method: "POST" })
  .validator(createProjectSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();

    return context.db.transaction(async (tx) => {
      const [newProject] = await tx
        .insert(project)
        .values({
          id: data.id,
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

      return { ...newProject, collaborators: [] };
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
  });

export const createProjectNode = createServerFn({ method: "POST" })
  .validator(createNodeSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    return context.db.transaction(async (tx) => {
      // Serialize structure changes with deletion and verify ownership before
      // accepting a parent supplied by the client.
      const [ownedProject] = await tx
        .select({ id: project.id })
        .from(project)
        .where(
          and(
            eq(project.id, data.projectId),
            eq(project.ownerId, session.user.id),
            isNull(project.deletedAt),
          ),
        )
        .for("update");
      if (!ownedProject) throw new Error("Project not found");
      const parent = await tx.query.projectNode.findFirst({
        where: {
          id: data.parentId,
          projectId: data.projectId,
          kind: "folder",
          deletedAt: { isNull: true },
        },
      });
      if (!parent) throw new Error("Folder not found");
      const [node] = await tx
        .insert(projectNode)
        .values({ ...data, sizeBytes: 0n })
        .returning({
          id: projectNode.id,
          projectId: projectNode.projectId,
          parentId: projectNode.parentId,
          name: projectNode.name,
          kind: projectNode.kind,
        });
      if (!node) throw new Error("Failed to create file");
      await tx
        .update(project)
        .set({ updatedAt: new Date() })
        .where(eq(project.id, data.projectId));
      return node;
    });
  });
