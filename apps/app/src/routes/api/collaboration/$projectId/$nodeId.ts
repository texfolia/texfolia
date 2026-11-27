import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { requestPrincipal } from "#/lib/auth/request-principal.server";
import {
  collaborationProtocol,
  documentIdSchema,
  maxNameLength,
  peopleSearchParam,
  protocolSearchParam,
} from "#/lib/collaboration";

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
            nodeId: documentIdSchema,
            clientId: z.coerce.number().int().nonnegative().max(0xffffffff),
          })
          .safeParse({
            ...params,
            clientId: searchParams.get("clientId"),
          });
        if (!parsed.success)
          return new Response("File not found", { status: 404 });
        // Construct the internal session here; never forward identity headers from clients.
        // Project and file access is verified once inside the Durable Object.
        const headers = new Headers({ Upgrade: "websocket" });
        headers.set(
          "X-Collaboration-Session",
          JSON.stringify({
            ...parsed.data,
            userId: principal.userId,
            name: principal.name.slice(0, maxNameLength),
            awareness: null,
            // Older tabs still speak base64 JSON; the room asks them to reload.
            binary:
              searchParams.get(protocolSearchParam) === collaborationProtocol,
            people: searchParams.get(peopleSearchParam) === "1",
          }),
        );
        return env.COLLABORATION.getByName(params.projectId).fetch(
          new Request(request.url, { headers }),
        );
      },
    },
  },
});
