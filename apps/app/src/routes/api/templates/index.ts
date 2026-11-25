import { createFileRoute } from "@tanstack/react-router";

import { templateQuerySchema } from "#/lib/templates";
import { listTemplates } from "#/lib/templates/server";

export const Route = createFileRoute("/api/templates/")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const url = new URL(request.url);
        const query = templateQuerySchema.parse(
          Object.fromEntries(url.searchParams),
        );
        const templates = await listTemplates({ db: context.db, ...query });
        return Response.json(templates, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Cache-Control": "public, max-age=60",
            "Content-Type": "application/json",
          },
        });
      },
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Max-Age": "86400",
          },
        }),
    },
  },
});
