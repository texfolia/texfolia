import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { requestPrincipal } from "#/lib/auth/request-principal.server";
import { readProjectSource } from "#/lib/projects/project-source.server";

export const Route = createFileRoute("/api/sources/$projectId/$nodeId")({
  server: {
    handlers: {
      GET: async ({ request, context, params }) => {
        const principal = await requestPrincipal({
          request,
          auth: context.auth,
          db: context.db,
          projectId: params.projectId,
        });
        if (!principal) return new Response("Unauthorized", { status: 401 });
        if (
          !z.uuid().safeParse(params.projectId).success ||
          !z.uuid().safeParse(params.nodeId).success
        )
          return new Response("File not found", { status: 404 });
        try {
          const bytes = await readProjectSource({
            db: context.db,
            bucket: env.SOURCES,
            userId: principal.userId,
            ...params,
          });
          return new Response(bytes, {
            headers: {
              "Content-Type": "application/octet-stream",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          if (
            error instanceof Error &&
            ["File not found", "Project not found"].includes(error.message)
          )
            return new Response("File not found", { status: 404 });
          throw error;
        }
      },
    },
  },
});
