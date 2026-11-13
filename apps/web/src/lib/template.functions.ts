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
    const server = await import("./template.server");
    return server.listTemplates({ db: context.db, page: data.page });
  });

export const listMyTemplates = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await ensureSession();
    const server = await import("./template.server");
    return server.listMyTemplates({ db: context.db, userId: session.user.id });
  },
);

export const getTemplate = createServerFn({ method: "GET" })
  .validator(templateIdSchema)
  .handler(async ({ context, data }) => {
    const server = await import("./template.server");
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
    const server = await import("./template.server");
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
    const server = await import("./template.server");
    const result = await server.publishTemplate({
      db: context.db,
      bucket: env.SOURCES,
      userId: session.user.id,
      data,
    });
    await server.refreshTemplatePreviews({
      db: context.db,
      bucket: env.SOURCES,
      templateId: result.id,
    });
    return result;
  });

export const refreshTemplatePreview = createServerFn({ method: "POST" })
  .validator(templateIdSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./template.server");
    const found = await server.findTemplate({
      db: context.db,
      userId: session.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS,
      ...data,
    });
    if (
      !found ||
      (found.ownerId !== session.user.id &&
        !server.isTemplateReviewer(
          session.user.id,
          env.TEMPLATE_REVIEWER_IDS ?? "",
        ))
    )
      throw new Error("Template not found");
    await server.refreshTemplatePreviews({
      db: context.db,
      bucket: env.SOURCES,
      ...data,
    });
  });

export const openTemplate = createServerFn({ method: "POST" })
  .validator(openTemplateSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./template.server");
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
    const server = await import("./template.server");
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
    const server = await import("./template.server");
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
    const server = await import("./template.server");
    return server.reviewTemplate({
      db: context.db,
      userId: session.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS ?? "",
      ...data,
    });
  });

export const seedTemplateStarters = createServerFn({ method: "POST" }).handler(
  async ({ context }) => {
    const session = await ensureSession();
    const server = await import("./template-seed.server");
    const result = await server.seedTemplateStarters({
      db: context.db,
      bucket: env.SOURCES,
      userId: session.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS,
    });
    const previews = await import("./template.server");
    for (const item of result)
      await previews.refreshTemplatePreviews({
        db: context.db,
        bucket: env.SOURCES,
        templateId: item.id,
      });
    return result;
  },
);
