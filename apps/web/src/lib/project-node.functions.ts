import { createServerFn } from "@tanstack/react-start";

import { ensureSession } from "./auth.functions";
import { createNodeSchema } from "./project-node.schema";

export const createProjectNode = createServerFn({ method: "POST" })
  .validator(createNodeSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-node.server");
    return server.createProjectNode({
      db: context.db,
      ownerId: session.user.id,
      data,
    });
  });
