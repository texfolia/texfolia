import { stripe, type SubscriptionOptions } from "@better-auth/stripe";
// Checkout, the customer portal and Stripe webhooks are Better Auth Stripe
// plugin endpoints. createAuth installs the plugin and its policy.
import { paidPlans } from "@texfolia/contracts/plans";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Member } from "better-auth/plugins/organization";
import Stripe from "stripe";

import { isOrgAdmin } from "#/lib/auth/roles";

import { subscriptionPlans } from "./plans";

/** Stripe Tax product codes for Texfolia's SaaS plans and metered AI add-on. */
export const stripeTaxCodes = {
  pro: "txcd_10103000",
  team: "txcd_10103001",
  ai: "txcd_10103001",
} as const;

export const allowedAiTaxCodes: ReadonlySet<string> = new Set([
  stripeTaxCodes.pro,
  stripeTaxCodes.team,
]);

/** Whether Stripe Automatic Tax is opted in for checkout and price validation. */
export function isStripeAutomaticTaxEnabled(
  value = process.env.STRIPE_AUTOMATIC_TAX,
) {
  return value?.trim().toLowerCase() === "true";
}

function productTaxCode(product: Stripe.Price["product"]) {
  if (typeof product === "string" || product.deleted) return null;
  return typeof product.tax_code === "string"
    ? product.tax_code
    : (product.tax_code?.id ?? null);
}

/** Validates a Stripe Pro or Team price, including tax fields when opted in. */
export function validatePlanPrice(
  plan: keyof typeof paidPlans,
  price: Stripe.Price,
  { automaticTax = false } = {},
) {
  const config = paidPlans[plan];
  if (
    !price.active ||
    price.currency !== "usd" ||
    price.unit_amount !== config.monthlyUsd * 100 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    price.billing_scheme !== "per_unit"
  ) {
    throw new Error(
      `The existing ${plan} price does not match the monthly plan`,
    );
  }
  if (!automaticTax) return;
  if (price.tax_behavior !== "exclusive") {
    throw new Error(
      `The ${plan} price (${price.id}) must have tax_behavior "exclusive" (found ${price.tax_behavior ?? "unset"}). Update it if "unspecified", or create a new price and rotate STRIPE_${plan.toUpperCase()}_PRICE_ID.`,
    );
  }
  const expectedTaxCode = stripeTaxCodes[plan];
  const actualTaxCode = productTaxCode(price.product);
  if (actualTaxCode !== expectedTaxCode) {
    throw new Error(
      `The ${plan} product must have tax_code "${expectedTaxCode}" (found ${actualTaxCode ?? "unset"}).`,
    );
  }
}

/** Validates the metered AI price, including tax fields when opted in. */
export function validateAiPrice(
  price: Stripe.Price,
  { automaticTax = false } = {},
) {
  if (
    !price.active ||
    price.currency !== "usd" ||
    Number(price.unit_amount_decimal) !== 0.0000001 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "metered" ||
    !price.recurring.meter
  ) {
    throw new Error(
      `The AI price (${price.id}) does not match the monthly USD metered nano-dollar plan`,
    );
  }
  if (!automaticTax) return;
  if (price.tax_behavior !== "exclusive") {
    throw new Error(
      `The AI price (${price.id}) must have tax_behavior "exclusive" (found ${price.tax_behavior ?? "unset"}). Update it if "unspecified", or create a new price and rotate STRIPE_AI_PRICE_ID.`,
    );
  }
  const actualTaxCode = productTaxCode(price.product);
  if (!actualTaxCode || !allowedAiTaxCodes.has(actualTaxCode)) {
    throw new Error(
      `The AI product must have a SaaS tax_code (${[...allowedAiTaxCodes].join(" or ")}; found ${actualTaxCode ?? "unset"}).`,
    );
  }
}

const stripeApiVersion = "2026-10-28.endive" as const;
const stripeClients = new Map<string, Stripe>();

/** Shared Stripe client per API key, reused across auth and AI metering. */
export function getStripeClient(apiKey: string) {
  let client = stripeClients.get(apiKey);
  if (!client) {
    client = new Stripe(apiKey, {
      apiVersion: stripeApiVersion,
      maxNetworkRetries: 0,
      timeout: 15_000,
    });
    stripeClients.set(apiKey, client);
  }
  return client;
}

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
  automaticTax = false,
  onSubscriptionChange,
}: {
  stripeClient: Stripe;
  webhookSecret: string;
  proPriceId: string;
  teamPriceId: string;
  createCustomerOnSignUp?: boolean;
  /** Enable Stripe Tax on Checkout Sessions (requires Stripe Tax enabled in Dashboard). */
  automaticTax?: boolean;
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
      ...(automaticTax
        ? {
            getCheckoutSessionParams: ({ subscription }) => ({
              params: {
                automatic_tax: { enabled: true },
                billing_address_collection: "required",
                tax_id_collection: { enabled: true },
                // Stripe requires both name and address to be "auto" when
                // tax_id_collection is enabled on an existing customer.
                // Better Auth's organization default omits name: "auto".
                ...(subscription.stripeCustomerId
                  ? { customer_update: { name: "auto", address: "auto" } }
                  : {}),
              },
            }),
          }
        : {}),
    },
  });
}
