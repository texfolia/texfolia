import type { Db } from "@texfolia/db";

import type { createAuth } from "#/lib/auth/auth";
import { requestPrincipal } from "#/lib/auth/request-principal.server";
import { compilePlan } from "#/lib/billing/server";

import { compileProject } from "./compile-source.server";
import { createCompileHandlers } from "./server";

export const compileHandlers = createCompileHandlers<{
  db: Db;
  auth: ReturnType<typeof createAuth>;
}>({
  principal: ({ request, projectId, context }) =>
    requestPrincipal({ request, projectId, ...context }),
  project: compileProject,
  compilePlan,
});
