import { createServerFn } from "@tanstack/react-start";
import {
  getRequestHeaders,
  getRequestUrl,
  setResponseHeader,
} from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/lib/auth/auth.functions";
import {
  createProjectSchema,
  updateProjectFormattingSchema,
  updateProjectMainFileSchema,
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
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
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

export const updateProjectMainFile = createServerFn({ method: "POST" })
  .validator(updateProjectMainFileSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project.server");
    return server.updateProjectMainFile({
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

/**
 * Everything `/project/$projectId` can show, for anyone who opens it. Signed-in
 * accounts get the workspace if they have access; a share cookie left from
 * before they signed in is redeemed onto the account first. Anonymous visitors
 * get the view-only guest page when their share cookie holds a live view link,
 * and are asked to sign in otherwise.
 */
export const openProject = createServerFn({ method: "GET" })
  .validator(projectIdSchema)
  .handler(async ({ data, context }) => {
    const headers = getRequestHeaders();
    const [{ readShareCookie, clearShareCookie }, sharing, session] =
      await Promise.all([
        import("#/lib/sharing/share-cookie.server"),
        import("#/lib/sharing/project-share-links.server"),
        context.auth.api.getSession({ headers }),
      ]);
    const token = readShareCookie(headers.get("Cookie"), data.projectId);
    const secure = getRequestUrl().protocol === "https:";
    setResponseHeader("Cache-Control", "private, no-store");
    if (session) {
      if (token !== null) {
        await sharing.redeemShareLink({
          db: context.db,
          token,
          userId: session.user.id,
          live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
        });
        setResponseHeader(
          "Set-Cookie",
          clearShareCookie(data.projectId, secure),
        );
      }
      const server = await import("./project.server");
      try {
        return {
          kind: "workspace" as const,
          userId: session.user.id,
          project: await server.getProject({
            db: context.db,
            ownerId: session.user.id,
            projectId: data.projectId,
            bucket: env.SOURCES,
          }),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "Project not found")
          return { kind: "missing" as const };
        throw error;
      }
    }
    if (token === null) return { kind: "sign-in" as const };
    const link = await sharing.resolveShareToken(context.db, token);
    if (link?.projectId === data.projectId && link.role !== "viewer")
      return { kind: "sign-in" as const };
    const shared = await sharing.getSharedProject({
      db: context.db,
      token,
      projectId: data.projectId,
    });
    if (shared) return { kind: "guest" as const, project: shared };
    setResponseHeader("Set-Cookie", clearShareCookie(data.projectId, secure));
    return { kind: "revoked" as const };
  });

export type OpenedProject = Awaited<ReturnType<typeof openProject>>;
export type GuestProject = Extract<OpenedProject, { kind: "guest" }>["project"];
