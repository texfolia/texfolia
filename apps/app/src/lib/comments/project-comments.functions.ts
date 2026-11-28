import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";

import { ensureSession } from "#/lib/auth/auth.functions";
import { createEmailDelivery } from "#/lib/email";

import {
  commentsSchema,
  commentThreadSchema,
  createCommentThreadSchema,
  deleteCommentSchema,
  deleteCommentThreadSchema,
  replyToCommentThreadSchema,
  resolveCommentThreadSchema,
  updateCommentSchema,
} from "./project-comments.schema";

export const listComments = createServerFn({ method: "GET" })
  .validator(commentsSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.listComments({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
    });
  });

export const getCommentThread = createServerFn({ method: "GET" })
  .validator(commentThreadSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.getCommentThread({
      db: context.db,
      userId: session.user.id,
      projectId: data.projectId,
      threadId: data.threadId,
    });
  });

export const createCommentThread = createServerFn({ method: "POST" })
  .validator(createCommentThreadSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.createCommentThread({
      db: context.db,
      userId: session.user.id,
      data,
      email: createEmailDelivery(env.BACKGROUND, process.env.BETTER_AUTH_URL),
    });
  });

export const replyToCommentThread = createServerFn({ method: "POST" })
  .validator(replyToCommentThreadSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.replyToCommentThread({
      db: context.db,
      userId: session.user.id,
      data,
      email: createEmailDelivery(env.BACKGROUND, process.env.BETTER_AUTH_URL),
    });
  });

export const resolveCommentThread = createServerFn({ method: "POST" })
  .validator(resolveCommentThreadSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.resolveCommentThread({
      db: context.db,
      userId: session.user.id,
      data,
    });
  });

export const deleteCommentThread = createServerFn({ method: "POST" })
  .validator(deleteCommentThreadSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.deleteCommentThread({
      db: context.db,
      userId: session.user.id,
      data,
    });
  });

export const updateComment = createServerFn({ method: "POST" })
  .validator(updateCommentSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.updateComment({
      db: context.db,
      userId: session.user.id,
      data,
      email: createEmailDelivery(env.BACKGROUND, process.env.BETTER_AUTH_URL),
    });
  });

export const deleteComment = createServerFn({ method: "POST" })
  .validator(deleteCommentSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./project-comments.server");
    return server.deleteComment({
      db: context.db,
      userId: session.user.id,
      data,
    });
  });
