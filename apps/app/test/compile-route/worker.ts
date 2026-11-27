import { createDb } from "@texfolia/db";
import { z } from "zod";

import { projectTools } from "#/lib/ai/server";

import { assistantWorkspace } from "../../src/lib/ai/assistant.server";
import { createAuth } from "../../src/lib/auth/auth";
import {
  CompileUsage,
  handleBuildQueue,
  ProjectBuilds as Builds,
} from "../../src/lib/builds/server";
import { Route } from "../../src/routes/api/compile/$projectId";

type TestEnv = Env & { SUBMISSIONS: Fetcher };

export { CompileUsage };

// The real coordinator, reporting each submission to the test.
export class ProjectBuilds extends Builds {
  override async fetch(request: Request) {
    if (!new URL(request.url).pathname.endsWith("/compile"))
      return super.fetch(request);
    const { SUBMISSIONS } = this.env as TestEnv;
    await SUBMISSIONS.fetch("http://submissions/before");
    const body = await request.text();
    const response = await super.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
      }),
    );
    const reported = await SUBMISSIONS.fetch("http://submissions/after", {
      method: "POST",
      body: JSON.stringify({
        id: request.headers.get("X-Compilation-Id") ?? "",
        body: JSON.parse(body),
        status: response.status,
      }),
    });
    if (!reported.ok) throw new Error("Lost coordinator acceptance response");
    return response;
  }
}

export default {
  queue: handleBuildQueue,
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
