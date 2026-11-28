import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/lib/auth/auth.functions";
import { createEmailDelivery } from "#/lib/email";

import {
  createShareLinkSchema,
  revokeShareLinkSchema,
  shareLinksSchema,
} from "./project-share-links.schema";

export const listShareLinks = createServerFn({ method: "GET" })
  .validator(shareLinksSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-share-links.server");
    return server.listShareLinks({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
    });
  });

export const createShareLink = createServerFn({ method: "POST" })
  .validator(createShareLinkSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-share-links.server");
    return server.createShareLink({
      db: context.db,
      userId: session.user.id,
      data,
      email: createEmailDelivery(env.BACKGROUND, process.env.BETTER_AUTH_URL),
    });
  });

export const revokeShareLink = createServerFn({ method: "POST" })
  .validator(revokeShareLinkSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-share-links.server");
    return server.revokeShareLink({
      db: context.db,
      userId: session.user.id,
      data,
      live: { collaboration: env.COLLABORATION, builds: env.BUILDS },
    });
  });
