import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { ensureSession } from "#/lib/auth/auth.functions";
import { gitActionSchema, gitRemoteSchema } from "#/lib/git";
import { projectNameSchema } from "#/lib/projects";

export const getGitAccounts = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    const { gitAccounts } = await import("./server");
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
    const { createProject, deleteTrashedProject, trashProject } =
      await import("#/lib/projects/project.server");
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
      // A failed import leaves nothing to recover, so it skips the trash.
      const failed = {
        db: context.db,
        userId: session.user.id,
        projectId: created.id,
      };
      await trashProject(failed);
      await deleteTrashedProject({
        ...failed,
        collaboration: env.COLLABORATION,
      });
      throw error;
    }
  });
