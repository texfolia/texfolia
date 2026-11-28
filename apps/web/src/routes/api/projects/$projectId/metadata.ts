import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { requestPrincipal } from "#/lib/auth/request-principal.server";
import { matchesEtag, weakEtag } from "#/lib/etag";
import { projectMetadataHash } from "#/lib/projects";
import { getProjectMetadata } from "#/lib/projects/project-metadata.server";

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
          // Workspaces resync on push, reconnect, and visibility regain; unchanged
          // resyncs return 304 without replacing client state.
          const etag = weakEtag(await projectMetadataHash(metadata));
          const tagged = { ...headers, ETag: etag };
          return matchesEtag(request, etag)
            ? new Response(null, { status: 304, headers: tagged })
            : Response.json(metadata, { headers: tagged });
        } catch (error) {
          if (error instanceof Error && error.message === "Project not found")
            return new Response("Project not found", { status: 404, headers });
          throw error;
        }
      },
    },
  },
});
