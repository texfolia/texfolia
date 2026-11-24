import type { Db } from "@texfolia/db";

import { BillingError } from "./usage";

/** A subscription still grants its plan until its paid period ends. */
function current(subscription: { periodEnd: Date | null }, now = new Date()) {
  return !subscription.periodEnd || subscription.periodEnd > now;
}

/** The compile plan: Team through any organization subscription, else Pro or free. */
export async function compilePlan(db: Db, userId: string) {
  const memberships = await db.query.member.findMany({
    columns: { organizationId: true },
    where: { userId },
  });
  const subscriptions = (
    await db.query.subscription.findMany({
      columns: { plan: true, referenceId: true, periodEnd: true },
      where: {
        referenceId: {
          in: [userId, ...memberships.map((member) => member.organizationId)],
        },
        plan: { in: ["pro", "team"] },
        status: { in: ["active", "trialing"] },
      },
    })
  ).filter((subscription) => current(subscription));
  if (
    subscriptions.some(
      (subscription) =>
        subscription.plan === "team" || subscription.referenceId !== userId,
    )
  )
    return "team";
  return subscriptions.length ? "pro" : "free";
}

/**
 * The Stripe customer and subscription that pay for this user's AI usage in a
 * project. An organization pays only for its members' usage in its own
 * projects; everywhere else, including personal projects and other
 * organizations' projects, the user's own subscription pays.
 */
export async function aiEntitlement(
  db: Db,
  userId: string,
  organizationId: string | null,
) {
  const membership = organizationId
    ? await db.query.member.findFirst({
        columns: { organizationId: true },
        where: { userId, organizationId },
      })
    : undefined;
  const subscriptions = await db.query.subscription.findMany({
    where: {
      referenceId: {
        in: membership ? [userId, membership.organizationId] : [userId],
      },
      plan: { in: ["pro", "team"] },
      status: { in: ["active", "trialing"] },
    },
  });
  const eligible = subscriptions.filter(
    (s) => s.stripeCustomerId && s.stripeSubscriptionId && current(s),
  );
  const subscription =
    (membership && eligible.find((s) => s.referenceId === organizationId)) ||
    eligible.find((s) => s.referenceId === userId);
  if (!subscription?.stripeCustomerId || !subscription.stripeSubscriptionId)
    throw new BillingError(
      organizationId && !membership
        ? "The assistant requires your own Pro plan in projects outside your organizations. Upgrade to use AI."
        : "The assistant requires Pro or Team. Upgrade to use AI.",
      403,
    );
  return {
    customerId: subscription.stripeCustomerId,
    subscriptionId: subscription.stripeSubscriptionId,
    /** The organization that pays, or null when the user pays. */
    organizationId:
      subscription.referenceId === userId ? null : subscription.referenceId,
  };
}
export type AiPayer = Awaited<ReturnType<typeof aiEntitlement>>;
