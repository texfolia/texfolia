// Checkout, the customer portal and Stripe webhooks are Better Auth Stripe
// plugin endpoints. createAuth installs the plugin and its policy.
import { stripe, type SubscriptionOptions } from "@better-auth/stripe";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Member } from "better-auth/plugins/organization";
import type Stripe from "stripe";

import { isOrgAdmin } from "#/features/auth/roles";

import { subscriptionPlans } from "./plans";

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

export const authorizeOrganizationBilling: NonNullable<
  SubscriptionOptions["authorizeReference"]
> = async ({ user, referenceId }, ctx) => {
  const customerType = ctx.body?.customerType ?? ctx.query?.customerType;
  if (customerType !== "organization") return referenceId === user.id;

  const membership = await ctx.context.adapter.findOne<Member>({
    model: "member",
    where: [
      { field: "organizationId", value: referenceId },
      { field: "userId", value: user.id },
    ],
  });

  return membership ? isOrgAdmin(membership.role) : false;
};

export function createBillingPlugin({
  stripeClient,
  webhookSecret,
  proPriceId,
  teamPriceId,
  createCustomerOnSignUp = true,
}: {
  stripeClient: Stripe;
  webhookSecret: string;
  proPriceId: string;
  teamPriceId: string;
  createCustomerOnSignUp?: boolean;
}) {
  return stripe({
    stripeClient,
    stripeWebhookSecret: webhookSecret,
    createCustomerOnSignUp,
    organization: { enabled: true },
    subscription: {
      enabled: true,
      authorizeReference: authorizeOrganizationBilling,
      plans: subscriptionPlans({ proPriceId, teamPriceId }),
    },
  });
}
