import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";

import { referenceResponse } from "#/lib/references.server";

export const Route = createFileRoute("/api/references/")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const session = await context.auth.api.getSession({
          headers: request.headers,
        });
        return referenceResponse({
          request,
          userId: session?.user.id ?? null,
          limiter: env.REFERENCE_LOOKUPS,
          cache:
            typeof caches === "undefined"
              ? undefined
              : await caches.open("references").catch(() => undefined),
        });
      },
    },
  },
});
