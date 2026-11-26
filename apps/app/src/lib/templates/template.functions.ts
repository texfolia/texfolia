import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl, setResponseHeader } from "@tanstack/react-start/server";
import type { Db } from "@texfolia/db";
import { env } from "cloudflare:workers";

import { ensureSession, getSession } from "#/lib/auth/auth.functions";
import {
  listTemplatesSchema,
  openTemplateSchema,
  publishTemplateSchema,
  refreshTemplatePreviewSchema,
  reportTemplateSchema,
  reviewTemplateSchema,
  setTemplatePublishedSchema,
  templateIdSchema,
} from "#/lib/templates";

export const listTemplates = createServerFn({ method: "GET" })
  .validator(listTemplatesSchema)
  .handler(async ({ context, data }) => {
    const server = await import("./server");
    return server.listTemplates({ db: context.db, ...data });
  });

export const listMyTemplates = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await ensureSession();
    const server = await import("./server");
    return server.listMyTemplates({ db: context.db, userId: session.user.id });
  },
);

/** Private templates the user may open, for the new-project picker. */
export const listPrivateTemplates = createServerFn({ method: "GET" })
  .validator(listTemplatesSchema.pick({ page: true, q: true }))
  .handler(async ({ context, data }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await ensureSession();
    const server = await import("./server");
    return server.listPrivateTemplates({
      db: context.db,
      userId: session.user.id,
      ...data,
    });
  });

async function templateAccount(db: Db, userId: string | undefined) {
  const server = await import("./server");
  return userId
    ? {
        signedIn: true,
        destinations: await server.templateDestinations({ db, userId }),
        canReview: server.isTemplateReviewer(
          userId,
          env.TEMPLATE_REVIEWER_IDS ?? "",
        ),
      }
    : { signedIn: false, destinations: [], canReview: false };
}

/** A template and what its viewer can do with it, from one session read. */
export const getTemplatePage = createServerFn({ method: "GET" })
  .validator(templateIdSchema)
  .handler(async ({ context, data }) => {
    const server = await import("./server");
    const session = await getSession();
    setResponseHeader("Cache-Control", "private, no-store");
    const template = await server.getTemplate({
      db: context.db,
      ...data,
      userId: session?.user.id,
      reviewers: env.TEMPLATE_REVIEWER_IDS,
    });
    if (!template) return null;
    return {
      template: {
        ...template,
        previewUrl: template.hasPreview
          ? new URL(`/api/templates/${template.id}/preview`, getRequestUrl())
              .href
          : null,
      },
      account: await templateAccount(context.db, session?.user.id),
    };
  });

export const getTemplateAccount = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    setResponseHeader("Cache-Control", "private, no-store");
    const session = await getSession();
    return templateAccount(context.db, session?.user.id);
  },
);

export const publishTemplate = createServerFn({ method: "POST" })
  .validator(publishTemplateSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./server");
    const { lockProject } = await import("#/lib/sharing/project-access.server");
    return server.publishTemplate({
      db: context.db,
      bucket: env.SOURCES,
      lock: lockProject,
      userId: session.user.id,
      data,
    });
  });

export const setTemplatePublished = createServerFn({ method: "POST" })
  .validator(setTemplatePublishedSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./server");
    await server.setTemplatePublished({
      db: context.db,
      userId: session.user.id,
      ...data,
    });
  });

export const deleteTemplate = createServerFn({ method: "POST" })
  .validator(templateIdSchema)
  .handler(async ({ context, data }) => {
    const session = await ensureSession();
    const server = await import("./server");
    await server.deleteTemplate({
      db: context.db,
      userId: session.user.id,
      ...data,
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
