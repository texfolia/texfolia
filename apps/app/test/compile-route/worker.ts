import { createDb } from "@texfolia/db";
import { z } from "zod";

import { projectTools } from "#/lib/ai/server";

import { assistantWorkspace } from "../../src/lib/ai/assistant.server";
import { createAuth } from "../../src/lib/auth/auth";
import { Route } from "../../src/routes/api/compile/$projectId";

export default {
  async fetch(request: Request, env: Env) {
    const projectId = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const db = createDb(env.HYPERDRIVE.connectionString);
    try {
      const auth = createAuth(db);
      if (new URL(request.url).searchParams.has("assistant")) {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return new Response(null, { status: 401 });
        const compile = projectTools({
          db,
          auth,
          workspace: assistantWorkspace(env),
          projectId,
          userId: session.user.id,
          canWrite: true,
          headers: request.headers,
          signal: request.signal,
        }).find((tool) => tool.name === "compile");
        if (!compile?.execute) throw new Error("Missing compile tool");
        const input = z
          .object({ mainFile: z.string() })
          .parse(await request.json());
        return Response.json(await compile.execute(input));
      }
      const handlers = Route.options.server?.handlers;
      if (!handlers || typeof handlers === "function")
        throw new Error("Missing compile handlers");
      const handler =
        request.method === "POST"
          ? handlers.POST
          : request.method === "PATCH"
            ? handlers.PATCH
            : handlers.GET;
      if (typeof handler !== "function")
        throw new Error("Missing compile handler");
      return await handler({
        request,
        context: { db, auth },
        params: { projectId },
        pathname: "/api/compile/$projectId",
        next: () => {
          throw new Error("Unexpected route chaining");
        },
      });
    } finally {
      await db.$client.end();
    }
  },
};
