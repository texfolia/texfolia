import type { Db } from "@texfolia/db";

import { BillingError } from "./usage";

/** The compile plan: Team through any organization subscription, else Pro or free. */
export async function compilePlan(db: Db, userId: string) {
  const memberships = await db.query.member.findMany({
    columns: { organizationId: true },
    where: { userId },
  });
  const subscriptions = await db.query.subscription.findMany({
    columns: { plan: true, referenceId: true },
    where: {
      referenceId: {
        in: [userId, ...memberships.map((member) => member.organizationId)],
      },
      plan: { in: ["pro", "team"] },
      status: { in: ["active", "trialing"] },
    },
  });
  if (
    subscriptions.some(
      (subscription) =>
        subscription.plan === "team" || subscription.referenceId !== userId,
    )
  )
    return "team";
  return subscriptions.length ? "pro" : "free";
}

/** The Stripe customer and subscription that pay for this user's AI usage. */
export async function aiEntitlement(
  db: Db,
  userId: string,
  organizationId?: string | null,
) {
  const memberships = await db.query.member.findMany({
    columns: { organizationId: true },
    where: { userId },
  });
  const subscriptions = await db.query.subscription.findMany({
    where: {
      referenceId: {
        in: [userId, ...memberships.map((m) => m.organizationId)],
      },
      plan: { in: ["pro", "team"] },
      status: { in: ["active", "trialing"] },
    },
  });
  const eligible = subscriptions.filter(
    (s) =>
      s.stripeCustomerId &&
      s.stripeSubscriptionId &&
      (!s.periodEnd || s.periodEnd > new Date()),
  );
  const subscription =
    eligible.find((s) => s.referenceId === organizationId) ??
    eligible.find((s) => s.referenceId === userId) ??
    eligible[0];
  if (!subscription?.stripeCustomerId || !subscription.stripeSubscriptionId)
    throw new BillingError(
      "The assistant requires Pro or Team. Upgrade to use AI.",
      403,
    );
  return {
    customerId: subscription.stripeCustomerId,
    subscriptionId: subscription.stripeSubscriptionId,
  };
}
export type AiPayer = Awaited<ReturnType<typeof aiEntitlement>>;
