import { createFileRoute } from "@tanstack/react-router";
import { findTemplate } from "@texfolia/templates/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

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
        if (!found?.previewKey)
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
