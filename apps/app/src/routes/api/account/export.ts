import { createFileRoute } from "@tanstack/react-router";
import { createDb } from "@texfolia/db";
import { env } from "cloudflare:workers";

import {
  accountArchive,
  exportAccountData,
} from "#/lib/settings/account-export.server";

export const Route = createFileRoute("/api/account/export")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const session = await context.auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true },
        });
        if (!session) return new Response("Unauthorized", { status: 401 });

        const userId = session.user.id;
        const archive = accountArchive({
          openDb: () => createDb(env.HYPERDRIVE.connectionString),
          bucket: env.SOURCES,
          userId,
          // Read before responding, so that a failure is not a broken archive.
          data: await exportAccountData(context.db, userId),
        });
        const date = new Date().toISOString().slice(0, 10);
        return new Response(archive, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="texfolia-account-export-${date}.zip"`,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
