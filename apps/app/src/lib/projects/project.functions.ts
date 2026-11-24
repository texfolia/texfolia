import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/lib/auth/auth.functions";
import {
  createProjectSchema,
  updateProjectFormattingSchema,
  updateProjectSpellingSchema,
  renameProjectSchema,
  projectTagsSchema,
  importProjectFilesSchema,
  projectsPageSchema,
  projectIdSchema,
} from "#/lib/projects";

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

export const trashProject = createServerFn({ method: "POST" })
  .validator(projectIdSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.trashProject({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
      collaboration: env.COLLABORATION,
    });
  });

export const restoreProject = createServerFn({ method: "POST" })
  .validator(projectIdSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.restoreProject({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
    });
  });

export const deleteTrashedProject = createServerFn({ method: "POST" })
  .validator(projectIdSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.deleteTrashedProject({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
      collaboration: env.COLLABORATION,
    });
  });

export const duplicateProject = createServerFn({ method: "POST" })
  .validator(projectIdSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.duplicateProject({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
      bucket: env.SOURCES,
    });
  });

export const getTrashedProjects = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.getTrashedProjects({
      db: context.db,
      userId: session.user.id,
    });
  },
);

export type TrashedProject = Awaited<
  ReturnType<typeof getTrashedProjects>
>[number];

export const getProject = createServerFn({ method: "GET" })
  .validator(projectIdSchema)
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
