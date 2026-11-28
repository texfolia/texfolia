import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Stripe from "stripe";

import { createOrganizationPlugin } from "#/lib/auth/auth";

import {
  createBillingPlugin,
  isStripeAutomaticTaxEnabled,
  stripeTaxCodes,
  validateAiPrice,
  validatePlanPrice,
} from "./stripe";

function createTestBillingAuth({ automaticTax }: { automaticTax?: boolean }) {
  const stripeClient = new Stripe("sk_test_stripe_tax_unit");
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "stripe-tax-unit-test-secret-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      team: [],
      teamMember: [],
      invitation: [],
      subscription: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      createOrganizationPlugin({
        baseURL: "http://localhost:3000",
        sendInvitationEmail: async () => {},
      }),
      createBillingPlugin({
        stripeClient,
        webhookSecret: "whsec_stripe_tax_unit",
        createCustomerOnSignUp: false,
        proPriceId: "price_pro",
        teamPriceId: "price_team",
        automaticTax,
      }),
    ],
  });
  return { auth, stripeClient };
}

async function setupPayers(
  auth: ReturnType<typeof createTestBillingAuth>["auth"],
) {
  const { response, headers } = await auth.api.signUpEmail({
    body: {
      email: "tax-owner@example.com",
      name: "Tax Owner",
      password: "test-password-123456",
    },
    returnHeaders: true,
  });
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(response.user.id, {
    emailVerified: true,
    stripeCustomerId: "cus_personal",
  });
  const requestHeaders = new Headers({
    cookie: headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
    origin: "http://localhost:3000",
  });
  const organization = await auth.api.createOrganization({
    headers: requestHeaders,
    body: { name: "Tax Lab", slug: "tax-lab" },
  });
  assert(organization);
  await ctx.adapter.update({
    model: "organization",
    where: [{ field: "id", value: organization.id }],
    update: { stripeCustomerId: "cus_team" },
  });
  return { headers: requestHeaders, organization };
}

test("isStripeAutomaticTaxEnabled defaults off and only enables on 'true'", () => {
  expect(isStripeAutomaticTaxEnabled(undefined)).toBe(false);
  expect(isStripeAutomaticTaxEnabled("")).toBe(false);
  expect(isStripeAutomaticTaxEnabled("false")).toBe(false);
  expect(isStripeAutomaticTaxEnabled("1")).toBe(false);
  expect(isStripeAutomaticTaxEnabled("yes")).toBe(false);
  expect(isStripeAutomaticTaxEnabled("true")).toBe(true);
  expect(isStripeAutomaticTaxEnabled(" TRUE ")).toBe(true);
});

function mockStripeCheckout(stripeClient: Stripe, sessionId: string) {
  spyOn(stripeClient.subscriptions, "list").mockImplementation((async () => ({
    data: [],
  })) as never);
  spyOn(stripeClient.prices, "retrieve").mockImplementation((async (
    id: string,
  ) => ({
    id,
    recurring: { usage_type: "licensed" },
  })) as never);
  return spyOn(stripeClient.checkout.sessions, "create").mockImplementation(
    (async () => ({
      id: sessionId,
      url: `https://checkout.stripe.com/c/pay/${sessionId}`,
    })) as never,
  );
}

test("checkout omits automatic_tax and collection params when automaticTax is off", async () => {
  const { auth, stripeClient } = createTestBillingAuth({ automaticTax: false });
  const { headers, organization } = await setupPayers(auth);
  const createSession = mockStripeCheckout(stripeClient, "cs_test_off");

  await auth.api.upgradeSubscription({
    headers,
    body: {
      plan: "pro",
      customerType: "user",
      successUrl: "/settings/billing",
      cancelUrl: "/settings/billing",
      disableRedirect: true,
    },
  });
  await auth.api.upgradeSubscription({
    headers,
    body: {
      plan: "team",
      customerType: "organization",
      referenceId: organization.id,
      successUrl: "/settings/billing",
      cancelUrl: "/settings/billing",
      disableRedirect: true,
    },
  });

  expect(createSession).toHaveBeenCalledTimes(2);
  const proParams = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
  const teamParams = createSession.mock.calls[1]?.[0] as Record<
    string,
    unknown
  >;

  expect(proParams.automatic_tax).toBeUndefined();
  expect(proParams.billing_address_collection).toBeUndefined();
  expect(proParams.tax_id_collection).toBeUndefined();

  expect(teamParams.automatic_tax).toBeUndefined();
  expect(teamParams.billing_address_collection).toBeUndefined();
  expect(teamParams.tax_id_collection).toBeUndefined();
  expect(teamParams.customer_update).toEqual({ address: "auto" });
});

test("checkout enables automatic_tax, billing address, tax ID collection, and full customer_update when automaticTax is on", async () => {
  const { auth, stripeClient } = createTestBillingAuth({ automaticTax: true });
  const { headers, organization } = await setupPayers(auth);
  const createSession = mockStripeCheckout(stripeClient, "cs_test_on");

  await auth.api.upgradeSubscription({
    headers,
    body: {
      plan: "pro",
      customerType: "user",
      successUrl: "/settings/billing",
      cancelUrl: "/settings/billing",
      disableRedirect: true,
    },
  });
  await auth.api.upgradeSubscription({
    headers,
    body: {
      plan: "team",
      customerType: "organization",
      referenceId: organization.id,
      successUrl: "/settings/billing",
      cancelUrl: "/settings/billing",
      disableRedirect: true,
    },
  });

  expect(createSession).toHaveBeenCalledTimes(2);
  const proParams = createSession.mock.calls[0]?.[0] as Record<string, unknown>;
  const teamParams = createSession.mock.calls[1]?.[0] as Record<
    string,
    unknown
  >;

  for (const params of [proParams, teamParams]) {
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe("required");
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.customer_update).toEqual({ name: "auto", address: "auto" });
  }
});

function planPriceFixture(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: "price_pro",
    active: true,
    currency: "usd",
    unit_amount: 1500,
    billing_scheme: "per_unit",
    tax_behavior: "exclusive",
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
    },
    product: {
      id: "prod_pro",
      deleted: false,
      tax_code: stripeTaxCodes.pro,
    },
    ...overrides,
  } as unknown as Stripe.Price;
}

function aiPriceFixture(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: "price_ai",
    active: true,
    currency: "usd",
    unit_amount_decimal: "0.0000001",
    tax_behavior: "exclusive",
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "metered",
      meter: "mtr_ai",
    },
    product: {
      id: "prod_ai",
      deleted: false,
      tax_code: stripeTaxCodes.ai,
    },
    ...overrides,
  } as unknown as Stripe.Price;
}

test("validatePlanPrice skips tax checks when automaticTax is off and enforces exclusive + SaaS tax_code when on", () => {
  const untaxedPro = planPriceFixture({
    tax_behavior: "unspecified",
    product: { id: "prod_pro", deleted: false, tax_code: null } as never,
  });
  expect(() =>
    validatePlanPrice("pro", untaxedPro, { automaticTax: false }),
  ).not.toThrow();
  expect(() =>
    validatePlanPrice("pro", untaxedPro, { automaticTax: true }),
  ).toThrow(/tax_behavior "exclusive"/);

  const validPro = planPriceFixture();
  expect(() =>
    validatePlanPrice("pro", validPro, { automaticTax: true }),
  ).not.toThrow();

  const genericTaxCodePro = planPriceFixture({
    product: {
      id: "prod_pro",
      deleted: false,
      tax_code: "txcd_10000000",
    } as never,
  });
  expect(() =>
    validatePlanPrice("pro", genericTaxCodePro, { automaticTax: true }),
  ).toThrow(stripeTaxCodes.pro);

  const validTeam = planPriceFixture({
    id: "price_team",
    unit_amount: 2000,
    product: {
      id: "prod_team",
      deleted: false,
      tax_code: stripeTaxCodes.team,
    } as never,
  });
  expect(() =>
    validatePlanPrice("team", validTeam, { automaticTax: true }),
  ).not.toThrow();

  const swappedTeam = planPriceFixture({
    id: "price_team",
    unit_amount: 2000,
    product: {
      id: "prod_team",
      deleted: false,
      tax_code: stripeTaxCodes.pro,
    } as never,
  });
  expect(() =>
    validatePlanPrice("team", swappedTeam, { automaticTax: true }),
  ).toThrow(stripeTaxCodes.team);
});

test("validateAiPrice enforces exclusive tax_behavior and SaaS tax_code when automaticTax is on", () => {
  const untaxedAi = aiPriceFixture({
    tax_behavior: "unspecified",
    product: { id: "prod_ai", deleted: false, tax_code: null } as never,
  });
  expect(() =>
    validateAiPrice(untaxedAi, { automaticTax: false }),
  ).not.toThrow();
  expect(() => validateAiPrice(untaxedAi, { automaticTax: true })).toThrow(
    /tax_behavior "exclusive"/,
  );

  expect(() =>
    validateAiPrice(aiPriceFixture(), { automaticTax: true }),
  ).not.toThrow();
  expect(() =>
    validateAiPrice(
      aiPriceFixture({
        product: {
          id: "prod_ai",
          deleted: false,
          tax_code: stripeTaxCodes.pro,
        } as never,
      }),
      { automaticTax: true },
    ),
  ).not.toThrow();
  expect(() =>
    validateAiPrice(
      aiPriceFixture({
        product: {
          id: "prod_ai",
          deleted: false,
          tax_code: "txcd_10000000",
        } as never,
      }),
      { automaticTax: true },
    ),
  ).toThrow(/SaaS tax_code/);
});
