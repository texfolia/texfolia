import { createFileRoute } from "@tanstack/react-router";
import { createDb } from "@texfolia/db";
import { env, waitUntil } from "cloudflare:workers";

import { checkHealth } from "#/lib/health";

export const Route = createFileRoute("/api/health/")({
  server: {
    handlers: {
      GET: async () => {
        // Not the request's connection, which would hold the response until a
        // query without an answer ends.
        const db = createDb(env.HYPERDRIVE.connectionString);
        const response = await checkHealth(() => db.execute("select 1"));
        waitUntil(db.$client.end());
        return response;
      },
    },
  },
});
