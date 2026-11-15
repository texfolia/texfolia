import { createDb } from "@texfolia/db";
import { project } from "@texfolia/db/schema";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { createAuth } from "../../src/lib/auth";
import {
  collectProjectSources,
  deleteProjectNode,
} from "../../src/lib/project-source.server";
import { deleteProject } from "../../src/lib/project.server";
import { Route as collaborationRoute } from "../../src/routes/api/collaboration/$projectId/$nodeId";
import { Route as compileRoute } from "../../src/routes/api/compile/$projectId";
export { ProjectCollaboration } from "../../src/lib/collaboration/project-collaboration";

// Exercise production route authorization with real signed sessions and Postgres.
export default {
  async fetch(request: Request, env: Env & { CLIENT: Fetcher }) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/cleanup/")) {
      const db = createDb(env.HYPERDRIVE.connectionString);
      const [, , action, projectId = "", nodeId = ""] = url.pathname.split("/");
      try {
        if (action === "collect")
          await collectProjectSources({
            db,
            bucket: env.SOURCES,
            collaboration: env.COLLABORATION,
          });
        else if (action === "delete-after-purge")
          await collectProjectSources({
            db,
            bucket: env.SOURCES,
            collaboration: {
              getByName: (id) => ({
                async purgeDeletedSources() {
                  const result =
                    await env.COLLABORATION.getByName(id).purgeDeletedSources(
                      id,
                    );
                  if (id === projectId)
                    await db
                      .update(project)
                      .set({ deletedAt: new Date() })
                      .where(eq(project.id, id));
                  return result;
                },
              }),
            },
          });
        else if (action === "project")
          await deleteProject({
            db,
            ownerId: request.headers.get("X-Owner") ?? "",
            projectId,
            collaboration: env.COLLABORATION,
          });
        else if (action === "node")
          await deleteProjectNode({
            db,
            userId: request.headers.get("X-Owner") ?? "",
            projectId,
            nodeId,
            collaboration: env.COLLABORATION,
          });
        else if (action === "purge")
          await env.COLLABORATION.getByName(projectId).purgeDeletedSources(
            projectId,
          );
        else throw new Error("Unknown cleanup action");
        return new Response(null, { status: 204 });
      } catch (error) {
        console.error("Cleanup fixture failed", error);
        return new Response("Cleanup failed", { status: 500 });
      } finally {
        await db.$client.end();
      }
    }
    if (url.pathname === "/client.js") return env.CLIENT.fetch(request);
    if (url.pathname.startsWith("/fixture/"))
      return env.COMPILER.fetch(
        new Request(url.href.replace("/fixture", ""), request),
      );
    if (!url.pathname.startsWith("/api/"))
      return new Response(
        '<!doctype html><html><head><title>Collaboration integration</title></head><body><script type="module" src="/client.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    const [, , channel, projectId = "", nodeId = ""] = url.pathname.split("/");
    const db = createDb(env.HYPERDRIVE.connectionString);
    const context = { db, auth: createAuth(db) };
    try {
      const next = () => {
        throw new Error("Unexpected route chaining");
      };
      if (channel === "collaboration") {
        const handlers = collaborationRoute.options.server?.handlers;
        if (
          !handlers ||
          typeof handlers === "function" ||
          typeof handlers.GET !== "function"
        )
          throw new Error("Missing collaboration GET route");
        return await handlers.GET({
          request,
          context,
          params: { projectId, nodeId },
          pathname: "/api/collaboration/$projectId/$nodeId",
          next,
        });
      }
      const handlers = compileRoute.options.server?.handlers;
      if (
        !handlers ||
        typeof handlers === "function" ||
        typeof handlers.GET !== "function"
      )
        throw new Error("Missing compile GET route");
      return await handlers.GET({
        request,
        context,
        params: { projectId },
        pathname: "/api/compile/$projectId",
        next,
      });
    } finally {
      await db.$client.end();
    }
  },
};

export class CompilerServiceFixture extends WorkerEntrypoint<{
  COMPILER_STREAMS: DurableObjectNamespace<CompilerFixture>;
}> {
  override fetch(request: Request) {
    const projectId = new URL(request.url).pathname.split("/")[2] ?? "";
    return this.env.COMPILER_STREAMS.getByName(projectId).fetch(request);
  }
}

export class CompilerFixture extends DurableObject {
  private recipients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  override async fetch(request: Request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const recipients = this.recipients;
    if (parts[1] === "emit") {
      const bytes = new TextEncoder().encode(await request.text());
      for (const controller of recipients) controller.enqueue(bytes);
      return Response.json({ recipients: recipients.size });
    }
    if (parts[1] === "subscribers")
      return Response.json({ recipients: recipients.size });
    if (url.pathname.endsWith("/events") || url.pathname.endsWith("/pdf")) {
      let subscription: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            subscription = controller;
            recipients.add(controller);
            controller.enqueue(
              new TextEncoder().encode(
                url.pathname.endsWith("/events")
                  ? "data: attached\n\n"
                  : "%PDF-attached\n",
              ),
            );
          },
          cancel() {
            recipients.delete(subscription);
          },
        }),
        {
          headers: {
            "Content-Type": url.pathname.endsWith("/events")
              ? "text/event-stream"
              : "application/pdf",
          },
        },
      );
    }
    return new Response(null, { status: 204 });
  }
}
