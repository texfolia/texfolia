import { createFileRoute } from "@tanstack/react-router";
import { findTemplate, templateArchive } from "@texfolia/templates/server";
import { env } from "cloudflare:workers";
import { z } from "zod";

export const Route = createFileRoute("/api/templates/$templateId/source")({
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
        return new Response(
          await templateArchive({ bucket: env.SOURCES, found }),
          {
            headers: {
              "Content-Type": "application/zip",
              "Content-Disposition": `attachment; filename="texfolia-template-${found.id}.zip"`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
              "X-Robots-Tag": "noindex, nofollow",
            },
          },
        );
      },
    },
  },
});
