import { createFileRoute } from "@tanstack/react-router";

import { compileHandlers } from "#/features/compile/compile-route.server";

export const Route = createFileRoute("/api/compile/$projectId")({
  server: {
    handlers: {
      POST: ({ request, params, context }) =>
        compileHandlers.POST({ request, params, context }),
      GET: ({ request, params, context }) =>
        compileHandlers.GET({ request, params, context }),
      PATCH: ({ request, params, context }) =>
        compileHandlers.PATCH({ request, params, context }),
    },
  },
});
