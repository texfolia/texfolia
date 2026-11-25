// Checkout, the customer portal and Stripe webhooks are Better Auth Stripe
// plugin endpoints. createAuth installs the plugin and its policy.
import { stripe, type SubscriptionOptions } from "@better-auth/stripe";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Member } from "better-auth/plugins/organization";
import type Stripe from "stripe";

import { isOrgAdmin } from "#/lib/auth/roles";

import { subscriptionPlans } from "./plans";

type BillingRequest = {
  path?: string;
  body?: any;
};

export function assertBillingScope(ctx: BillingRequest) {
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
}

export const enforceBillingScope = createAuthMiddleware(async (ctx) =>
  assertBillingScope(ctx),
);

// Nothing is left to renew in these, as in Better Auth's check of organizations.
const endedStatuses = ["canceled", "incomplete", "incomplete_expired"];

/**
 * Whether Stripe would keep billing this customer. One that is set to cancel
 * ends by itself.
 */
export async function hasRenewingSubscription(
  stripeClient: Stripe,
  customer: string,
) {
  for await (const subscription of stripeClient.subscriptions.list({
    customer,
    status: "all",
    limit: 100,
  }))
    if (
      !endedStatuses.includes(subscription.status) &&
      !subscription.cancel_at_period_end &&
      !subscription.cancel_at
    )
      return true;
  return false;
}

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
  onSubscriptionChange,
}: {
  stripeClient: Stripe;
  webhookSecret: string;
  proPriceId: string;
  teamPriceId: string;
  createCustomerOnSignUp?: boolean;
  /** Called after a webhook reports a changed or deleted subscription. */
  onSubscriptionChange?: (stripeSubscriptionId: string) => Promise<void>;
}) {
  return stripe({
    stripeClient,
    stripeWebhookSecret: webhookSecret,
    createCustomerOnSignUp,
    organization: { enabled: true },
    async onEvent(event) {
      if (
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      )
        await onSubscriptionChange?.(event.data.object.id);
    },
    subscription: {
      enabled: true,
      authorizeReference: authorizeOrganizationBilling,
      plans: subscriptionPlans({ proPriceId, teamPriceId }),
    },
  });
}
