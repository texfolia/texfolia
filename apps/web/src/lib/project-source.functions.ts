import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { ensureSession } from "./auth.functions";
import { saveSourceSchema } from "./project-source";

export const saveProjectSource = createServerFn({ method: "POST" })
  .validator(saveSourceSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
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
    });
  });
