import { createDb } from "@texfolia/db";
import { user as userTable } from "@texfolia/db/schema";
import { gitActionSchema } from "@texfolia/git";
import { collectGitObjects } from "@texfolia/git/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { createAuth } from "../../src/lib/auth";
import { collectProjectSources } from "../../src/lib/project-source.server";
import { Route as collaborationRoute } from "../../src/routes/api/collaboration/$projectId/$nodeId";
export { ProjectCollaboration } from "../../src/lib/project-collaboration.server";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const db = createDb(env.HYPERDRIVE.connectionString);
    try {
      if (url.pathname.startsWith("/api/collaboration/")) {
        const [, , , projectId = "", nodeId = ""] = url.pathname.split("/");
        const handlers = collaborationRoute.options.server?.handlers;
        if (
          !handlers ||
          typeof handlers === "function" ||
          typeof handlers.GET !== "function"
        )
          throw new Error("Missing collaboration handler");
        return await handlers.GET({
          request,
          context: { db, auth: createAuth(db) },
          params: { projectId, nodeId },
          pathname: "/api/collaboration/$projectId/$nodeId",
          next: () => {
            throw new Error("Unexpected next");
          },
        });
      }
      if (url.pathname === "/collect") {
        await collectProjectSources({
          db,
          bucket: env.SOURCES,
          collaboration: env.COLLABORATION,
        });
        await collectGitObjects({ db, bucket: env.SOURCES });
        return Response.json({ ok: true });
      }
      const data = z
        .object({
          projectId: z.uuid(),
          userId: z.string(),
          action: gitActionSchema,
        })
        .parse(await request.json());
      const [user] = await db
        .select()
        .from(userTable)
        .where(eq(userTable.id, data.userId));
      if (!user) throw new Error("Missing fixture user");
      const result = await env.COLLABORATION.getByName(
        data.projectId,
      ).gitAction({
        projectId: data.projectId,
        user: { id: user.id, name: user.name, email: user.email },
        action: data.action,
      });
      return Response.json({ status: result.status, diff: result.diff });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Git failed" },
        { status: 400 },
      );
    } finally {
      await db.$client.end();
    }
  },
};
