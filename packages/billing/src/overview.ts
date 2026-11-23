import { isOrgAdmin } from "@texfolia/auth/roles";
import type { Db } from "@texfolia/db";

/**
 * The billing settings page: the user's organizations, the selected
 * organization's members and invitations, and the subscriptions of the
 * selected payer (the organization, or the user) when the user may manage them.
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
          members: {
            columns: { id: true, userId: true, role: true },
            with: { user: { columns: { email: true } } },
          },
          invitations: { columns: { id: true, email: true, status: true } },
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
  return {
    organizations: organizations.map(({ id, name }) => ({ id, name })),
    selected: selected
      ? {
          id: selected.id,
          name: selected.name,
          members: selected.members.flatMap((m) =>
            m.user ? [{ ...m, user: m.user }] : [],
          ),
          invitations: selected.invitations,
        }
      : null,
    canManage,
    subscriptions: subscriptions.map(
      ({ plan, status, periodEnd, cancelAtPeriodEnd }) => ({
        plan,
        status,
        periodEnd,
        cancelAtPeriodEnd,
      }),
    ),
    userId,
  };
}
export type BillingOverview = Awaited<ReturnType<typeof billingOverview>>;
