import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getProjectMetadata } from "#/lib/project-metadata.server";

export const Route = createFileRoute("/api/projects/$projectId/metadata")({
  server: {
    handlers: {
      GET: async ({ request, context, params }) => {
        const headers = { "Cache-Control": "no-store" };
        const session = await context.auth.api.getSession({
          headers: request.headers,
        });
        if (!session)
          return new Response("Unauthorized", { status: 401, headers });
        if (!z.uuid().safeParse(params.projectId).success)
          return new Response("Project not found", { status: 404, headers });
        try {
          const metadata = await getProjectMetadata({
            db: context.db,
            projectId: params.projectId,
            userId: session.user.id,
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
