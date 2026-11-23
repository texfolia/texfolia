import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { saveSourceSchema } from "#/features/storage";

import { ensureSession } from "./auth.functions";

export const saveProjectSource = createServerFn({ method: "POST" })
  .validator(saveSourceSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const node = await context.db.query.projectNode.findFirst({
      where: {
        id: data.nodeId,
        projectId: data.projectId,
        deletedAt: { isNull: true },
      },
    });
    if (node?.kind === "text")
      return env.COLLABORATION.getByName(data.projectId).saveSource({
        data,
        userId: session.user.id,
        name: session.user.name,
      });
    const server = await import("./project-source.server");
    return server.saveProjectSource({
      db: context.db,
      bucket: env.SOURCES,
      userId: session.user.id,
      data,
    });
  });

export const deleteProjectNode = createServerFn({ method: "POST" })
  .validator(z.object({ projectId: z.uuid(), nodeId: z.uuid() }))
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-source.server");
    return server.deleteProjectNode({
      db: context.db,
      userId: session.user.id,
      ...data,
      collaboration: env.COLLABORATION,
    });
  });
