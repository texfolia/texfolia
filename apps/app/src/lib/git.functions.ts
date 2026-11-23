import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { gitActionSchema, gitRemoteSchema } from "#/features/git";
import { projectNameSchema } from "#/features/projects";

import { ensureSession } from "./auth.functions";

export const getGitAccounts = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    const { gitAccounts } = await import("#/features/git/server");
    return gitAccounts({ db: context.db, userId: session.user.id });
  },
);

export const getGitBranch = createServerFn({ method: "GET" })
  .validator(z.object({ projectId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const { gitBranch } = await import("./git.server");
    return gitBranch({
      db: context.db,
      projectId: data.projectId,
      userId: session.user.id,
    });
  });

export const gitAction = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.uuid(), action: gitActionSchema }))
  .handler(async ({ data }) => {
    const session = await ensureSession();
    if (data.action.kind === "import")
      throw new Error("Import a repository as a new project.");
    const result = await env.COLLABORATION.getByName(data.projectId).gitAction({
      ...data,
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      },
    });
    return { status: result.status, diff: result.diff };
  });

export const importGitProject = createServerFn({ method: "POST" })
  .validator(z.object({ name: projectNameSchema, remote: gitRemoteSchema }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const { createProject, deleteProject } = await import("./project.server");
    const created = await createProject({
      db: context.db,
      ownerId: session.user.id,
      data: { id: crypto.randomUUID(), name: data.name },
    });
    try {
      await env.COLLABORATION.getByName(created.id).gitAction({
        projectId: created.id,
        user: {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
        },
        action: { kind: "import", remote: data.remote },
      });
      return { projectId: created.id };
    } catch (error) {
      await deleteProject({
        db: context.db,
        ownerId: session.user.id,
        projectId: created.id,
        collaboration: env.COLLABORATION,
      });
      throw error;
    }
  });
