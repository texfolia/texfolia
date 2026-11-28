import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { requestPrincipal } from "#/lib/auth/request-principal.server";
import {
  maxNameLength,
  multiplexCollaborationProtocol,
  peopleSearchParam,
  protocolSearchParam,
} from "#/lib/collaboration";

export const Route = createFileRoute("/api/collaboration/$projectId/")({
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
        const parsed = z.uuid().safeParse(params.projectId);
        if (!parsed.success)
          return new Response("Project not found", { status: 404 });
        const searchParams = new URL(request.url).searchParams;
        if (
          searchParams.get(protocolSearchParam) !==
          multiplexCollaborationProtocol
        )
          return new Response("Unsupported protocol", { status: 400 });
        // Construct the internal session here; never forward identity headers from clients.
        // Project access is verified once inside the Durable Object.
        const headers = new Headers({ Upgrade: "websocket" });
        headers.set(
          "X-Collaboration-Session",
          JSON.stringify({
            multiplex: true,
            sessionId: crypto.randomUUID(),
            projectId: parsed.data,
            userId: principal.userId,
            name: principal.name.slice(0, maxNameLength),
            people: searchParams.get(peopleSearchParam) === "1",
          }),
        );
        return env.COLLABORATION.getByName(parsed.data).fetch(
          new Request(request.url, { headers }),
        );
      },
    },
  },
});
