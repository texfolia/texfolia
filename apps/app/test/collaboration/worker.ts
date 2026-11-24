import { createDb } from "@texfolia/db";
import { project } from "@texfolia/db/schema";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";

import { invalidateOrganizationCollaborationAccess } from "#/lib/collaboration/server";

import { createAuth } from "../../src/lib/auth/auth";
import { ProjectCollaboration as Room } from "../../src/lib/collaboration/project-collaboration.server";
import {
  collectProjectSources,
  deleteProjectNode,
} from "../../src/lib/projects/project-source.server";
import {
  deleteTrashedProject,
  restoreProject,
  trashProject,
} from "../../src/lib/projects/project.server";
import {
  createShareLink,
  revokeShareLink,
} from "../../src/lib/sharing/project-share-links.server";
import {
  grantProjectAccess,
  revokeProjectAccess,
} from "../../src/lib/sharing/project-sharing.server";
import { Route as collaborationRoute } from "../../src/routes/api/collaboration/$projectId/$nodeId";
import { Route as compileRoute } from "../../src/routes/api/compile/$projectId";

// Count Postgres use and alarms so tests can assert edits stay off the database.
export class ProjectCollaboration extends Room {
  private databaseUses = 0;
  private alarms = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const room = this as unknown as {
      withDb: (operation: unknown) => Promise<unknown>;
    };
    const withDb = room.withDb.bind(this);
    room.withDb = (operation) => {
      this.databaseUses++;
      return withDb(operation);
    };
  }

  override async alarm() {
    this.alarms++;
    return super.alarm();
  }

  async usage() {
    return { databaseUses: this.databaseUses, alarms: this.alarms };
  }
}

// Exercise production route authorization with real signed sessions and Postgres.
export default {
  async fetch(request: Request, env: Env & { CLIENT: Fetcher }) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/cleanup/")) {
      const db = createDb(env.HYPERDRIVE.connectionString);
      const userId = request.headers.get("X-Owner") ?? "";
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
                    await db.delete(project).where(eq(project.id, id));
                  return result;
                },
              }),
            },
          });
        // Deletes without purging the room, as when the purge call fails.
        else if (action === "project-only") {
          await trashProject({ db, userId, projectId });
          await deleteTrashedProject({ db, userId, projectId });
        } else if (action === "project") {
          await trashProject({ db, userId, projectId });
          await deleteTrashedProject({
            db,
            userId,
            projectId,
            collaboration: env.COLLABORATION,
          });
        } else if (action === "trash")
          await trashProject({
            db,
            userId,
            projectId,
            collaboration: env.COLLABORATION,
          });
        else if (action === "restore")
          await restoreProject({ db, userId, projectId });
        else if (action === "node")
          await deleteProjectNode({
            db,
            userId,
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
    if (url.pathname.startsWith("/access/")) {
      // Run the production revocation paths, which notify collaboration rooms.
      const db = createDb(env.HYPERDRIVE.connectionString);
      const [, , action, projectId = ""] = url.pathname.split("/");
      const ownerId = request.headers.get("X-Owner") ?? "";
      const body: Record<string, string> = await request.json();
      try {
        if (action === "grant")
          await grantProjectAccess({
            db,
            userId: ownerId,
            data: {
              projectId,
              email: body.email ?? "",
              role: body.role === "editor" ? "editor" : "viewer",
            },
            collaboration: env.COLLABORATION,
          });
        else if (action === "revoke")
          await revokeProjectAccess({
            db,
            userId: ownerId,
            data: { projectId, userId: body.userId ?? "" },
            collaboration: env.COLLABORATION,
          });
        else if (action === "share-create")
          return Response.json(
            await createShareLink({
              db,
              userId: ownerId,
              data: {
                projectId,
                scope: body.scope === "pdf" ? "pdf" : "project",
              },
            }),
          );
        else if (action === "share-revoke")
          await revokeShareLink({
            db,
            userId: ownerId,
            data: { projectId, linkId: body.linkId ?? "" },
            collaboration: env.COLLABORATION,
          });
        else if (action === "member-removed")
          await invalidateOrganizationCollaborationAccess({
            db,
            collaboration: env.COLLABORATION,
            organizationId: body.organizationId ?? "",
            userId: body.userId ?? "",
          });
        else throw new Error("Unknown access action");
        return new Response(null, { status: 204 });
      } catch (error) {
        console.error("Access fixture failed", error);
        return new Response("Access change failed", { status: 500 });
      } finally {
        await db.$client.end();
      }
    }
    if (url.pathname.startsWith("/scratchpad/")) {
      // The RPC behind the assistant's read_scratchpad tool.
      const projectId = url.pathname.split("/")[2] ?? "";
      const body: Record<string, string> = await request.json();
      try {
        return new Response(
          await env.COLLABORATION.getByName(projectId).readScratchpad({
            projectId,
            userId: body.userId ?? "",
          }),
        );
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    if (url.pathname.startsWith("/usage/"))
      return Response.json(
        await (
          env.COLLABORATION as unknown as DurableObjectNamespace<ProjectCollaboration>
        )
          .getByName(url.pathname.split("/")[2] ?? "")
          .usage(),
      );
    if (url.pathname === "/client.js") return env.CLIENT.fetch(request);
    if (url.pathname.startsWith("/fixture/"))
      return env.BUILDS.getByName(url.pathname.split("/")[3] ?? "").fetch(
        new Request(url.href.replace("/fixture", ""), request),
      );
    if (!url.pathname.startsWith("/api/"))
      return new Response(
        '<!doctype html><html><head><title>Collaboration integration</title></head><body><script type="module" src="/client.js"></script></body></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    const [, , channel, projectId = "", nodeId = ""] = url.pathname.split("/");
    const db = createDb(env.HYPERDRIVE.connectionString);
    const context = { db, auth: createAuth(db, env.COLLABORATION) };
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

// Stands in for a project's build coordinator.
export class BuildsFixture extends DurableObject {
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
