import { createFileRoute } from "@tanstack/react-router";

import { exportAccountData } from "#/lib/settings/account-export.server";

export const Route = createFileRoute("/api/account/export")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const session = await context.auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true },
        });
        if (!session) return new Response("Unauthorized", { status: 401 });

        const payload = await exportAccountData(context.db, session.user.id);
        const date = new Date().toISOString().slice(0, 10);
        return new Response(JSON.stringify(payload, null, 2), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="texfolia-account-export-${date}.json"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});
