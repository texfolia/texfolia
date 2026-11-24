import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { findTemplate, streamTemplatePreview } from "#/lib/templates/server";

export const Route = createFileRoute("/api/templates/$templateId/preview")({
  server: {
    handlers: {
      GET: async ({ request, context, params }) => {
        if (!z.uuid().safeParse(params.templateId).success)
          return new Response("Not found", { status: 404 });
        const session = await context.auth.api.getSession({
          headers: request.headers,
        });
        const found = await findTemplate({
          db: context.db,
          templateId: params.templateId,
          userId: session?.user.id,
          reviewers: env.TEMPLATE_REVIEWER_IDS,
        });
        if (!found) return new Response("Not found", { status: 404 });
        if (new URL(request.url).searchParams.get("events") === "1")
          return streamTemplatePreview({
            db: context.db,
            connectionString: env.HYPERDRIVE.connectionString,
            bucket: env.SOURCES,
            found,
            signal: request.signal,
          });
        if (!found.previewKey)
          return new Response("Not found", { status: 404 });
        const object = await env.SOURCES.get(found.previewKey);
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Robots-Tag":
              found.visibility === "unlisted" || found.status !== "approved"
                ? "noindex, nofollow"
                : "all",
          },
        });
      },
    },
  },
});
