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
  scratchpadId,
} from "#/lib/collaboration";
import {
  collaborationAccess,
  scratchpadAccess,
} from "#/lib/collaboration/server";
import { lockProject } from "#/lib/sharing/project-access.server";

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
        try {
          if (parsed.data.nodeId === scratchpadId)
            await scratchpadAccess(
              context.db,
              params.projectId,
              principal.userId,
              { lock: lockProject },
            );
          else
            await collaborationAccess(
              context.db,
              params.projectId,
              params.nodeId,
              principal.userId,
              { lock: lockProject },
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
