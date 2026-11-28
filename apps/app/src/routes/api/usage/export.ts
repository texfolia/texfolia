import { createFileRoute } from "@tanstack/react-router";

import { BillingError } from "#/lib/billing";
import { getUsageDashboard } from "#/lib/billing/server";
import {
  formatUsageCsv,
  usagePeriods,
  type UsagePeriod,
} from "#/lib/billing/usage-analytics";

function parsePeriod(raw: string | null): UsagePeriod {
  if (raw && (usagePeriods as readonly string[]).includes(raw)) {
    return raw as UsagePeriod;
  }
  return "current_month";
}

export const Route = createFileRoute("/api/usage/export")({
  server: {
    handlers: {
      GET: async ({ request, context }) => {
        const session = await context.auth.api.getSession({
          headers: request.headers,
          query: { disableCookieCache: true },
        });
        if (!session) return new Response("Unauthorized", { status: 401 });

        const url = new URL(request.url);
        const period = parsePeriod(url.searchParams.get("period"));
        const rawOrg = url.searchParams.get("organizationId")?.trim();
        const organizationId = rawOrg ? rawOrg : undefined;

        try {
          const dashboard = await getUsageDashboard(context.db, {
            userId: session.user.id,
            organizationId,
            period,
          });
          const csv = formatUsageCsv(dashboard);
          const slug = dashboard.organization
            ? dashboard.organization.name
                .toLowerCase()
                .replaceAll(/[^a-z0-9]+/g, "-")
                .replaceAll(/^-|-$/g, "") || "team"
            : "personal";
          const date = new Date().toISOString().slice(0, 10);
          return new Response(csv, {
            headers: {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="texfolia-usage-${slug}-${period}-${date}.csv"`,
              "Cache-Control": "private, no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          if (error instanceof BillingError) {
            return new Response(error.message, { status: error.status });
          }
          throw error;
        }
      },
    },
  },
});
