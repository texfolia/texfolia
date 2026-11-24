import type { Db } from "@texfolia/db";
import { env } from "cloudflare:workers";

import type { createAuth } from "#/lib/auth/auth";
import { requestPrincipal } from "#/lib/auth/request-principal.server";
import { compilePlan } from "#/lib/billing/server";
import { streamProjectResponse } from "#/lib/projects/server";
import { lockProject } from "#/lib/sharing/project-access.server";

import { compileProject } from "./compile-source.server";
import { createCompileHandlers } from "./server";

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
