import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { listTemplates } from "#/lib/templates/server";

const pageSchema = z.coerce.number().int().min(0).max(1000).catch(0);

export const Route = createFileRoute("/api/templates/")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const url = new URL(request.url);
        const page = pageSchema.parse(url.searchParams.get("page") ?? "0");
        const templates = await listTemplates({ db: context.db, page });
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
