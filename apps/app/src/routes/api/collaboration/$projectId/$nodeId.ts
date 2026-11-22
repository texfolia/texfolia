import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  collaborationProtocol,
  protocolSearchParam,
} from "#/lib/collaboration/protocol";
import { collaborationAccess } from "#/lib/collaboration/sources.server";
import { requestPrincipal } from "#/lib/request-principal.server";

export const Route = createFileRoute("/api/collaboration/$projectId/$nodeId")({
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
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
          return new Response("WebSocket required", { status: 426 });
        if (new URL(request.url).origin !== request.headers.get("Origin"))
          return new Response("Invalid origin", { status: 403 });
        const searchParams = new URL(request.url).searchParams;
        const parsed = z
          .object({
            projectId: z.uuid(),
            nodeId: z.uuid(),
            clientId: z.coerce.number().int().nonnegative().max(0xffffffff),
          })
          .safeParse({
            ...params,
            clientId: searchParams.get("clientId"),
          });
        if (!parsed.success)
          return new Response("File not found", { status: 404 });
        try {
          await collaborationAccess(
            context.db,
            params.projectId,
            params.nodeId,
            principal.userId,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            ["Project not found", "File not found"].includes(error.message)
          )
            return new Response("File not found", { status: 404 });
          throw error;
        }
        // Construct the internal session here; never forward identity headers from clients.
        const headers = new Headers({ Upgrade: "websocket" });
        headers.set(
          "X-Collaboration-Session",
          JSON.stringify({
            ...parsed.data,
            userId: principal.userId,
            name: principal.name.slice(0, 200),
            awareness: null,
            // Older tabs still speak base64 JSON; the room asks them to reload.
            binary:
              searchParams.get(protocolSearchParam) === collaborationProtocol,
          }),
        );
        return env.COLLABORATION.getByName(params.projectId).fetch(
          new Request(request.url, { headers }),
        );
      },
    },
  },
});
