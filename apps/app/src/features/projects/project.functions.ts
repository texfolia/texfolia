import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { ensureSession } from "#/features/auth/auth.functions";
import {
  createProjectSchema,
  updateProjectFormattingSchema,
  updateProjectSpellingSchema,
  renameProjectSchema,
  projectTagsSchema,
  importProjectFilesSchema,
  projectsPageSchema,
} from "#/features/projects";

export const createProject = createServerFn({ method: "POST" })
  .validator(createProjectSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.createProject({
      db: context.db,
      ownerId: session.user.id,
      data,
    });
  });

export const getProjects = createServerFn({ method: "GET" })
  .validator(projectsPageSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.getProjects({
      db: context.db,
      userId: session.user.id,
      limit: data?.limit,
      cursor: data?.cursor,
    });
  });

export const deleteProject = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.deleteProject({
      db: context.db,
      ownerId: session.user.id,
      projectId: data.projectId,
      collaboration: env.COLLABORATION,
    });
  });

export const getProject = createServerFn({ method: "GET" })
  .validator(z.object({ projectId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.getProject({
      db: context.db,
      ownerId: session.user.id,
      projectId: data.projectId,
      bucket: env.SOURCES,
    });
  });

export type Project = Awaited<
  ReturnType<typeof getProjects>
>["projects"][number];
export type ProjectDetails = Awaited<ReturnType<typeof getProject>>;
export type ProjectNode = ProjectDetails["nodes"][number];

export const renameProject = createServerFn({ method: "POST" })
  .validator(renameProjectSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.renameProject({
      db: context.db,
      ownerId: session.user.id,
      data,
    });
  });

export const setProjectTags = createServerFn({ method: "POST" })
  .validator(projectTagsSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.setProjectTags({
      db: context.db,
      ownerId: session.user.id,
      data,
    });
  });

export const importProjectFiles = createServerFn({ method: "POST" })
  .validator(importProjectFilesSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-import.server");
    return server.importProjectFiles({
      db: context.db,
      bucket: env.SOURCES,
      ownerId: session.user.id,
      data,
    });
  });

export const updateProjectSpelling = createServerFn({ method: "POST" })
  .validator(updateProjectSpellingSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.updateProjectSpelling({
      db: context.db,
      ownerId: session.user.id,
      data,
    });
  });

export const updateProjectFormatting = createServerFn({ method: "POST" })
  .validator(updateProjectFormattingSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.updateProjectFormatting({
      db: context.db,
      ownerId: session.user.id,
      data,
    });
  });
