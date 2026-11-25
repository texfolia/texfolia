import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  findTemplate,
  streamTemplatePreview,
  templatePreview,
} from "#/lib/templates/server";

export const Route = createFileRoute("/api/templates/$templateId/preview")({
  server: {
    handlers: {
      GET: async ({ request, context, params }) => {
        if (!z.uuid().safeParse(params.templateId).success)
          return new Response("Not found", { status: 404 });
        const { db } = context;
        const { templateId } = params;
        // Anyone can see an approved template, so only others need a session.
        let found = await findTemplate({ db, templateId });
        if (!found) {
          const session = await context.auth.api.getSession({
            headers: request.headers,
          });
          found = session
            ? await findTemplate({
                db,
                templateId,
                userId: session.user.id,
                reviewers: env.TEMPLATE_REVIEWER_IDS,
              })
            : null;
        }
        if (!found) return new Response("Not found", { status: 404 });
        if (new URL(request.url).searchParams.get("events") === "1")
          return streamTemplatePreview({
            db,
            connectionString: env.HYPERDRIVE.connectionString,
            bucket: env.SOURCES,
            found,
            signal: request.signal,
          });
        return templatePreview({
          request,
          bucket: env.SOURCES,
          images: env.IMAGES,
          found,
        });
      },
    },
  },
});
