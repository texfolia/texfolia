import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/features/auth/auth.functions";

import {
  createShareLinkSchema,
  revokeShareLinkSchema,
  sharedProjectSchema,
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
      collaboration: env.COLLABORATION,
    });
  });

// Anonymous: the token is the credential.
export const getSharedProject = createServerFn({ method: "GET" })
  .validator(sharedProjectSchema)
  .handler(async ({ data, context }) => {
    const server = await import("./project-share-links.server");
    try {
      return await server.getSharedProject({
        db: context.db,
        token: data.token,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        ["Share link not found", "Project not found"].includes(error.message)
      )
        return null;
      throw error;
    }
  });
