export type BillingSearch = { plan?: "pro" | "team"; organizationId?: string };

/** The billing page's search. The router keeps raw values of omitted keys. */
export function billingSearch(search: Record<string, unknown>): BillingSearch {
  const { plan, organizationId } = search;
  return {
    plan: plan === "pro" || plan === "team" ? plan : undefined,
    organizationId:
      typeof organizationId === "string" && organizationId
        ? organizationId
        : undefined,
  };
}
