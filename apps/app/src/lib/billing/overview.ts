import type { Db } from "@texfolia/db";
import { aiOrganizationSettings } from "@texfolia/db/schema";

import { isOrgAdmin } from "#/lib/auth/roles";

import { getOrganizationAiSettings, payerAiSpend } from "./metering";
import { BillingError, nanoDollars } from "./usage";

/**
 * The billing settings page: the user's organizations, and the subscriptions of
 * the selected payer (the organization, or the user) when the user may manage
 * them.
 */
export async function billingOverview(
  db: Db,
  { userId, organizationId }: { userId: string; organizationId?: string },
) {
  const memberships = await db.query.member.findMany({
    where: { userId },
    with: { organization: { columns: { id: true, name: true } } },
  });
  const organizations = memberships.flatMap((m) =>
    m.organization ? [m.organization] : [],
  );
  if (organizationId && !organizations.some((org) => org.id === organizationId))
    throw new Error("Organization not found");
  const selected = organizationId
    ? await db.query.organization.findFirst({
        where: { id: organizationId },
        columns: { id: true, name: true },
        with: {
          members: { columns: { userId: true, role: true } },
        },
      })
    : null;
  const membership = selected?.members.find((m) => m.userId === userId);
  const canManage = !selected || (!!membership && isOrgAdmin(membership.role));
  const subscriptions = canManage
    ? await db.query.subscription.findMany({
        where: {
          referenceId: selected?.id ?? userId,
          stripeSubscriptionId: { isNotNull: true },
          status: {
            in: [
              "active",
              "trialing",
              "past_due",
              "unpaid",
              "incomplete",
              "paused",
            ],
          },
        },
        orderBy: { periodEnd: "desc" },
      })
    : [];
  const ai =
    selected && canManage
      ? await organizationAi(db, selected.id, subscriptions)
      : null;
  return {
    organizations: organizations.map(({ id, name }) => ({ id, name })),
    selected: selected
      ? {
          id: selected.id,
          name: selected.name,
          seats: selected.members.length,
        }
      : null,
    canManage,
    ai,
    subscriptions: subscriptions.map(
      ({ plan, status, periodEnd, cancelAtPeriodEnd }) => ({
        plan,
        status,
        periodEnd,
        cancelAtPeriodEnd,
      }),
    ),
  };
}

async function organizationAi(
  db: Db,
  organizationId: string,
  subscriptions: { stripeCustomerId: string | null }[],
) {
  const customerIds = [
    ...new Set(subscriptions.flatMap((s) => s.stripeCustomerId ?? [])),
  ];
  const [settings, spend] = await Promise.all([
    getOrganizationAiSettings(db, organizationId),
    payerAiSpend(db, customerIds),
  ]);
  return {
    monthlyCapDollars: settings.monthlyCapNanos / nanoDollars,
    spentDollars: spend.spent / nanoDollars,
    reservedDollars: spend.reserved / nanoDollars,
  };
}

/** Sets an organization's shared AI spend cap. Owners and admins only. */
export async function saveOrganizationAiCap(
  db: Db,
  {
    userId,
    organizationId,
    dollars,
  }: { userId: string; organizationId: string; dollars: number },
) {
  const membership = await db.query.member.findFirst({
    columns: { role: true },
    where: { userId, organizationId },
  });
  if (!membership || !isOrgAdmin(membership.role))
    throw new BillingError(
      "Only an organization owner or admin can change its AI spend cap.",
      403,
    );
  const monthlyCapNanos = Math.round(dollars * nanoDollars);
  await db
    .insert(aiOrganizationSettings)
    .values({ organizationId, monthlyCapNanos })
    .onConflictDoUpdate({
      target: aiOrganizationSettings.organizationId,
      set: { monthlyCapNanos },
    });
}
export type BillingOverview = Awaited<ReturnType<typeof billingOverview>>;
