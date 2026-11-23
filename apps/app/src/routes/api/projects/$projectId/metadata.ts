import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { requestPrincipal } from "#/features/auth/request-principal.server";
import { getProjectMetadata } from "#/features/projects/project-metadata.server";

export const Route = createFileRoute("/api/projects/$projectId/metadata")({
  server: {
    handlers: {
      GET: async ({ request, context, params }) => {
        const headers = { "Cache-Control": "no-store" };
        const principal = await requestPrincipal({
          request,
          auth: context.auth,
          db: context.db,
          projectId: params.projectId,
        });
        if (!principal)
          return new Response("Unauthorized", { status: 401, headers });
        if (!z.uuid().safeParse(params.projectId).success)
          return new Response("Project not found", { status: 404, headers });
        try {
          const metadata = await getProjectMetadata({
            db: context.db,
            projectId: params.projectId,
            userId: principal.userId,
          });
          return Response.json(metadata, { headers });
        } catch (error) {
          if (error instanceof Error && error.message === "Project not found")
            return new Response("Project not found", { status: 404, headers });
          throw error;
        }
      },
    },
  },
});
