import { createDb } from "@texfolia/db";
import { project } from "@texfolia/db/schema";
import { eq } from "drizzle-orm";

import { liveUserHeader } from "#/lib/builds/client";
import { LiveProject } from "#/lib/builds/live-object.server";
import { requestCollaborationCleanup } from "#/lib/collaboration/server";
import { invalidateOrganizationAccess } from "#/lib/projects/server";

import { createAuth } from "../../src/lib/auth/auth";
import { ProjectCollaboration as Room } from "../../src/lib/collaboration/project-collaboration.server";
import { deleteProjectNode } from "../../src/lib/projects/project-source.server";
import {
  deleteTrashedProject,
  restoreProject,
  trashProject,
} from "../../src/lib/projects/project.server";
import { lockProject } from "../../src/lib/sharing/project-access.server";
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
import { collectProjectSources } from "../collection";

// Count Postgres use and alarms so tests can assert edits stay off the database.
export class ProjectCollaboration extends Room {
  private databaseUses = 0;
  private alarmRuns = 0;

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
    this.alarmRuns++;
    return super.alarm();
  }

  // Runs the periodic check now rather than after a minute.
  async backstop() {
    const room = this as unknown as {
      alarms: { plan: (duty: "access", at: number) => Promise<void> };
    };
    await room.alarms.plan("access", Date.now());
  }

  async usage() {
    const room = this as unknown as { documents: Map<string, unknown> };
    return {
      databaseUses: this.databaseUses,
      alarms: this.alarmRuns,
      documents: [...room.documents.keys()],
    };
  }
}

// Exercise production route authorization with real signed sessions and Postgres.
export default {
  async fetch(request: Request, env: Env & { CLIENT: Fetcher }) {
    const url = new URL(request.url);
    const live = { collaboration: env.COLLABORATION, builds: env.BUILDS };
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
        else if (action === "delete-after-purge") {
          await requestCollaborationCleanup(db, projectId);
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
        }
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
            live,
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
            live,
          });
        else if (action === "revoke")
          await revokeProjectAccess({
            db,
            userId: ownerId,
            data: { projectId, userId: body.userId ?? "" },
            live,
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
            live,
          });
        else if (action === "member-removed")
          await invalidateOrganizationAccess({
            db,
            live,
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
    const room = (
      env.COLLABORATION as unknown as DurableObjectNamespace<ProjectCollaboration>
    ).getByName(url.pathname.split("/")[2] ?? "");
    if (url.pathname.startsWith("/usage/"))
      return Response.json(await room.usage());
    if (url.pathname.startsWith("/backstop/")) {
      await room.backstop();
      return new Response(null, { status: 204 });
    }
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
    const context = { db, auth: createAuth(db, live) };
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

// Stands in for a project's build coordinator. Its live channel and access
// checks are the real ones; only the data is made up.
export class BuildsFixture extends LiveProject {
  private frame = "attached";
  private bodies = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private checks = 0;

  protected override liveFrame() {
    return this.frame;
  }

  protected override async checkLiveAccess(projectId: string, userId: string) {
    this.checks++;
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      await db.transaction((tx) =>
        lockProject({
          tx,
          projectId,
          userId,
          access: "read",
          content: "build",
        }),
      );
    } finally {
      await db.$client.end();
    }
  }

  override async fetch(request: Request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const { bodies } = this;
    if (parts[1] === "emit") {
      this.frame = await request.text();
      this.publish(parts[2] ?? "");
      const bytes = new TextEncoder().encode(this.frame);
      for (const controller of bodies) controller.enqueue(bytes);
      return Response.json({});
    }
    // Runs the periodic check now rather than after a minute.
    if (parts[1] === "backstop") {
      await this.plan("access", Date.now());
      return Response.json({});
    }
    if (parts[1] === "subscribers")
      return Response.json({
        recipients:
          bodies.size +
          this.ctx
            .getWebSockets()
            .filter((ws) => ws.readyState === WebSocket.OPEN).length,
        checks: this.checks,
      });
    if (url.pathname.endsWith("/events"))
      return this.openSocket(request, parts[2] ?? "");
    if (url.pathname.endsWith("/pdf")) {
      let subscription: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            subscription = controller;
            bodies.add(controller);
            controller.enqueue(new TextEncoder().encode("%PDF-attached\n"));
          },
          cancel() {
            bodies.delete(subscription);
          },
        }),
        { headers: { "Content-Type": "application/pdf" } },
      );
      return this.guard(
        response,
        parts[2] ?? "",
        request.headers.get(liveUserHeader) ?? "",
      );
    }
    return new Response(null, { status: 204 });
  }
}
