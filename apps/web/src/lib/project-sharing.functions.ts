import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "./auth.functions";
import {
  grantProjectAccessSchema,
  projectAccessSchema,
  revokeProjectAccessSchema,
} from "./project-sharing.schema";

export const getProjectAccess = createServerFn({ method: "GET" })
  .validator(projectAccessSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-sharing.server");
    return server.getProjectAccess({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
    });
  });
export const grantProjectAccess = createServerFn({ method: "POST" })
  .validator(grantProjectAccessSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-sharing.server");
    return server.grantProjectAccess({
      db: context.db,
      userId: session.user.id,
      data,
      collaboration: env.COLLABORATION,
    });
  });
export const revokeProjectAccess = createServerFn({ method: "POST" })
  .validator(revokeProjectAccessSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-sharing.server");
    return server.revokeProjectAccess({
      db: context.db,
      userId: session.user.id,
      data,
      collaboration: env.COLLABORATION,
    });
  });
