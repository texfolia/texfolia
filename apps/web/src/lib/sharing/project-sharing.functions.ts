import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/lib/auth/auth.functions";
import { createEmailDelivery } from "#/lib/email";

import {
  grantProjectAccessSchema,
  grantTeamAccessSchema,
  projectAccessSchema,
  revokeProjectAccessSchema,
  revokeTeamAccessSchema,
  setOrganizationRoleSchema,
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
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
      email: createEmailDelivery(env.BACKGROUND, process.env.BETTER_AUTH_URL),
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
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
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
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
    });
  });
export const setOrganizationRole = createServerFn({ method: "POST" })
  .validator(setOrganizationRoleSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-sharing.server");
    return server.setOrganizationRole({
      db: context.db,
      userId: session.user.id,
      data,
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
    });
  });
export const grantTeamAccess = createServerFn({ method: "POST" })
  .validator(grantTeamAccessSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-sharing.server");
    return server.grantTeamAccess({
      db: context.db,
      userId: session.user.id,
      data,
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
    });
  });
export const revokeTeamAccess = createServerFn({ method: "POST" })
  .validator(revokeTeamAccessSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-sharing.server");
    return server.revokeTeamAccess({
      db: context.db,
      userId: session.user.id,
      data,
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
    });
  });
