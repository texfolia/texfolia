import { createServerFn } from "@tanstack/react-start";
import { account } from "@texfolia/db/schema";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { ensureSession } from "./auth.functions";
import { gitActionSchema, gitScopes, gitRemoteSchema } from "./git";
import { projectNameSchema } from "./project.schema";

export const getGitAccounts = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    const accounts = await context.db
      .select({ provider: account.providerId, scope: account.scope })
      .from(account)
      .where(eq(account.userId, session.user.id));
    return {
      github: accounts.some(
        (a) =>
          a.provider === "github" &&
          gitScopes.github.every((s) => a.scope?.split(/[ ,]+/).includes(s)),
      ),
      gitlab: accounts.some(
        (a) =>
          a.provider === "gitlab" &&
          gitScopes.gitlab.every((s) => a.scope?.split(/[ ,]+/).includes(s)),
      ),
    };
  },
);

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
