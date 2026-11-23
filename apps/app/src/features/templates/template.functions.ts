import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";

import { ensureSession, getSession } from "#/features/auth/auth.functions";
import {
  listTemplatesSchema,
  openTemplateSchema,
  publishTemplateSchema,
  refreshTemplatePreviewSchema,
  reportTemplateSchema,
  reviewTemplateSchema,
  templateIdSchema,
} from "#/features/templates";

export const listTemplates = createServerFn({ method: "GET" })
  .validator(listTemplatesSchema)
  .handler(async ({ context, data }) => {
    const server = await import("./server");
    return server.listTemplates({ db: context.db, page: data.page });
  });

export const listMyTemplates = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await ensureSession();
    const server = await import("./server");
    return server.listMyTemplates({ db: context.db, userId: session.user.id });
  },
);

export const getTemplate = createServerFn({ method: "GET" })
  .validator(templateIdSchema)
  .handler(async ({ context, data }) => {
    const server = await import("./server");
    const session = await getSession();
    setResponseHeader("Cache-Control", "private, no-store");
    const result = await server.getTemplate({
      db: context.db,
      ...data,
      userId: session?.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS,
    });
    return result
      ? {
          ...result,
          previewUrl: result.hasPreview
            ? new URL(`/api/templates/${result.id}/preview`, getRequestUrl())
                .href
            : null,
        }
      : null;
  });

export const getTemplateAccount = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const server = await import("./server");
    const session = await getSession();
    return session
      ? {
          signedIn: true,
          destinations: await server.templateDestinations({
            db: context.db,
            userId: session.user.id,
          }),
          canReview: server.isTemplateReviewer(
            session.user.id,
            env.TEMPLATE_REVIEWER_IDS ?? "",
          ),
        }
      : { signedIn: false, destinations: [], canReview: false };
  },
);

export const publishTemplate = createServerFn({ method: "POST" })
  .validator(publishTemplateSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./server");
    const { lockProject } =
      await import("#/features/sharing/project-access.server");
    return server.publishTemplate({
      db: context.db,
      bucket: env.SOURCES,
      lock: lockProject,
      userId: session.user.id,
      data,
    });
  });

export const refreshTemplatePreview = createServerFn({ method: "POST" })
  .validator(refreshTemplatePreviewSchema)
  .handler(async ({ context, data }) => {
    const session = await getSession();
    const server = await import("./server");
    await server.refreshTemplatePreview({
      db: context.db,
      bucket: env.SOURCES,
      ...data,
      userId: session?.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS,
    });
  });

export const openTemplate = createServerFn({ method: "POST" })
  .validator(openTemplateSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./server");
    return server.openTemplate({
      db: context.db,
      bucket: env.SOURCES,
      userId: session.user.id,
      data,
    });
  });

export const reportTemplate = createServerFn({ method: "POST" })
  .validator(reportTemplateSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./server");
    return server.reportTemplate({
      db: context.db,
      userId: session.user.id,
      ...data,
    });
  });

export const getTemplateReviewQueue = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await ensureSession();
    const server = await import("./server");
    return server.templateReviewQueue({
      db: context.db,
      userId: session.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS ?? "",
    });
  },
);

export const reviewTemplate = createServerFn({ method: "POST" })
  .validator(reviewTemplateSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./server");
    return server.reviewTemplate({
      db: context.db,
      userId: session.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS ?? "",
      ...data,
    });
  });
