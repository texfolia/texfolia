import { createFileRoute, redirect } from "@tanstack/react-router";

import { billingSearch } from "#/lib/billing/billing-search";

export const Route = createFileRoute("/billing")({
  validateSearch: billingSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/billing", search, replace: true });
  },
});
