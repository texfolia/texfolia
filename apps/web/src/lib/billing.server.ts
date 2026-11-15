import type { Db } from "@texfolia/db";
import { APIError, createAuthMiddleware } from "better-auth/api";

export const enforceBillingScope = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== "/subscription/upgrade") return;
  const { plan, customerType, annual, seats } = ctx.body ?? {};
  if (
    (plan !== "pro" && plan !== "team") ||
    (plan === "team" && customerType !== "organization") ||
    (plan === "pro" && customerType === "organization") ||
    annual ||
    (plan === "pro" && seats !== undefined && seats !== 1)
  ) {
    throw new APIError("BAD_REQUEST", {
      message:
        "Choose Pro for a personal account or Team for an organization. Plans are billed monthly; Team seats follow organization membership.",
    });
  }
});

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
