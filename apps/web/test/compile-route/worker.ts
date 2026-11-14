import { createDb } from "@texfolia/db";

import { createAuth } from "../../src/lib/auth";
import { Route } from "../../src/routes/api.compile.$projectId";

export default {
  async fetch(request: Request, env: Env) {
    const projectId = new URL(request.url).pathname.split("/").at(-1) ?? "";
    const db = createDb(env.HYPERDRIVE.connectionString);
    try {
      const handlers = Route.options.server?.handlers;
      if (!handlers || typeof handlers === "function")
        throw new Error("Missing compile handlers");
      const handler = request.method === "POST" ? handlers.POST : handlers.GET;
      if (typeof handler !== "function")
        throw new Error("Missing compile handler");
      return await handler({
        request,
        context: { db, auth: createAuth(db) },
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
