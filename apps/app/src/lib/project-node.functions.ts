import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { createNodeSchema, renameNodeSchema } from "#/features/projects";

import { ensureSession } from "./auth.functions";

export const createProjectNode = createServerFn({ method: "POST" })
  .validator(createNodeSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-node.server");
    return server.createProjectNode({
      db: context.db,
      ownerId: session.user.id,
      data,
      bucket: env.SOURCES,
    });
  });

export const renameProjectNode = createServerFn({ method: "POST" })
  .validator(renameNodeSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-node.server");
    return server.renameProjectNode({
      db: context.db,
      userId: session.user.id,
      data,
    });
  });
