import type { Db } from "@texfolia/db";
import { env } from "cloudflare:workers";

import { compilePlan } from "#/features/billing/server";
import { createCompileHandlers } from "#/features/compile/server";
import { streamProjectResponse } from "#/features/projects/server";

import type { createAuth } from "./auth";
import { compileProject } from "./compile-source.server";
import { lockProject } from "./project-access.server";
import { requestPrincipal } from "./request-principal.server";

export const compileHandlers = createCompileHandlers<{
  db: Db;
  auth: ReturnType<typeof createAuth>;
}>({
  principal: ({ request, projectId, context }) =>
    requestPrincipal({ request, projectId, ...context }),
  project: compileProject,
  bucket: () => env.SOURCES,
  compilePlan,
  streamLive: (options) =>
    streamProjectResponse({
      ...options,
      connectionString: env.HYPERDRIVE.connectionString,
      lock: lockProject,
    }),
});

export const handleCompilePost = compileHandlers.POST;
export const handleCompileGet = compileHandlers.GET;
