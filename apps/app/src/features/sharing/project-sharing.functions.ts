import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/features/auth/auth.functions";
import { createEmailDelivery } from "#/features/email";

import {
  grantProjectAccessSchema,
  projectAccessSchema,
  revokeProjectAccessSchema,
  transferProjectSchema,
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
      email: createEmailDelivery(env.EMAIL, process.env.BETTER_AUTH_URL),
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
export const transferProject = createServerFn({ method: "POST" })
  .validator(transferProjectSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-transfer.server");
    return server.transferProject({
      db: context.db,
      userId: session.user.id,
      data,
      collaboration: env.COLLABORATION,
    });
  });
