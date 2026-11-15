import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl, setResponseHeader } from "@tanstack/react-start/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { ensureSession, getSession } from "./auth.functions";
import {
  openTemplateSchema,
  publishTemplateSchema,
  reportTemplateSchema,
  reviewTemplateSchema,
  templateIdSchema,
} from "./template.schema";

export const listTemplates = createServerFn({ method: "GET" })
  .validator(z.object({ page: z.number().int().min(0).max(1000).default(0) }))
  .handler(async ({ context, data }) => {
    const server = await import("./template-catalog.server");
    return server.listTemplates({ db: context.db, page: data.page });
  });

export const listMyTemplates = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await ensureSession();
    const server = await import("./template-catalog.server");
    return server.listMyTemplates({ db: context.db, userId: session.user.id });
  },
);

export const getTemplate = createServerFn({ method: "GET" })
  .validator(templateIdSchema)
  .handler(async ({ context, data }) => {
    const server = await import("./template-catalog.server");
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
    const server = await import("./template-catalog.server");
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
    const server = await import("./template-snapshot.server");
    const result = await server.publishTemplate({
      db: context.db,
      bucket: env.SOURCES,
      userId: session.user.id,
      data,
    });
    return result;
  });

export const refreshTemplatePreview = createServerFn({ method: "POST" })
  .validator(templateIdSchema.extend({ retry: z.boolean().default(false) }))
  .handler(async ({ context, data }) => {
    const session = await getSession();
    const catalog = await import("./template-catalog.server");
    const found = await catalog.findTemplate({
      db: context.db,
      templateId: data.templateId,
      userId: session?.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS,
    });
    if (!found) throw new Error("Template not found");
    const previews = await import("./template-preview.server");
    if (data.retry) {
      if (
        !session ||
        (found.ownerId !== session.user.id &&
          !catalog.isTemplateReviewer(
            session.user.id,
            env.TEMPLATE_REVIEWER_IDS ?? "",
          ))
      )
        throw new Error("Template not found");
      await previews.retryTemplatePreview({
        db: context.db,
        templateId: data.templateId,
      });
    }
    await previews.refreshTemplatePreviews({
      db: context.db,
      bucket: env.SOURCES,
      templateId: data.templateId,
    });
  });

export const openTemplate = createServerFn({ method: "POST" })
  .validator(openTemplateSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./template-snapshot.server");
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
    const server = await import("./template-review.server");
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
    const server = await import("./template-review.server");
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
    const server = await import("./template-review.server");
    return server.reviewTemplate({
      db: context.db,
      userId: session.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS ?? "",
      ...data,
    });
  });
