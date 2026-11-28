import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";

import { usagePeriods, type UsagePeriod } from "#/lib/billing";
import { getUsageDashboard } from "#/lib/billing/billing.functions";

import { UsageDashboardView } from "./-components/usage-dashboard";

type UsageSearch = {
  organizationId?: string;
  period?: UsagePeriod;
};

function validateUsageSearch(search: Record<string, unknown>): UsageSearch {
  const organizationId =
    typeof search.organizationId === "string" && search.organizationId
      ? search.organizationId
      : undefined;
  const period =
    typeof search.period === "string" &&
    (usagePeriods as readonly string[]).includes(search.period)
      ? (search.period as UsagePeriod)
      : undefined;
  return { organizationId, period };
}

export const Route = createFileRoute("/settings/usage")({
  validateSearch: validateUsageSearch,
  loaderDeps: ({ search }) => ({
    organizationId: search.organizationId,
    period: search.period,
  }),
  loader: ({ deps }) => getUsageDashboard({ data: deps }),
  head: () => ({ meta: [{ title: "Usage | Texfolia" }] }),
  component: UsagePage,
  errorComponent: UsageError,
});

function UsageError({ error }: { error: unknown }) {
  const router = useRouter();
  const message =
    error instanceof Error
      ? error.message
      : "We couldn't load usage data for this account.";
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Usage unavailable</h2>
      <p className="text-muted-foreground text-sm">{message}</p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void router.invalidate()}>Try again</Button>
        <Button
          variant="outline"
          render={<Link to="/settings/usage" search={{}} />}
        >
          Open personal usage
        </Button>
      </div>
    </div>
  );
}

function UsagePage() {
  const dashboard = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const search = Route.useSearch();

  return (
    <UsageDashboardView
      key={`${dashboard.organization?.id ?? "personal"}-${dashboard.period.id}`}
      dashboard={dashboard}
      onSelectPeriod={(period) => {
        void navigate({
          search: {
            organizationId: search.organizationId,
            period,
          },
        });
      }}
    />
  );
}
