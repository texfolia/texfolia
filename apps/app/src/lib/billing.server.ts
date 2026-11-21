import type { Db } from "@texfolia/db";

export { enforceBillingScope } from "@texfolia/auth";

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
