import assert from "node:assert/strict";

import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { createOrganizationPlugin } from "@texfolia/auth";
import {
  aiEntitlement,
  compilePlan,
  createBillingPlugin,
  enforceBillingScope,
} from "@texfolia/billing/server";
import { createDb } from "@texfolia/db";
import * as schema from "@texfolia/db/schema";
import { betterAuth } from "better-auth";
import { eq, inArray } from "drizzle-orm";
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
assert(
  key && key.startsWith("sk_test_"),
  "Billing integration requires a Stripe sandbox key",
);
const connection = process.env.INTEGRATION_DATABASE_URL;
assert(
  connection && new URL(connection).pathname.includes("test"),
  "Use an isolated test database",
);
const proPriceId = process.env.STRIPE_PRO_PRICE_ID;
const teamPriceId = process.env.STRIPE_TEAM_PRICE_ID;
assert(
  proPriceId && teamPriceId,
  "Run billing:setup and configure the sandbox price IDs",
);
const db = createDb(connection);
const stripe = new Stripe(key, {
  apiVersion: "2026-10-28.endive",
  maxNetworkRetries: 0,
});
const secret = "whsec_billing_integration_fixture";
const origin = "http://localhost:3000";
const auth = betterAuth({
  baseURL: origin,
  secret: "billing-integration-test-secret-at-least-32-characters",
  database: drizzleAdapter(db, { provider: "pg", schema }),
  emailAndPassword: { enabled: true },
  hooks: { before: enforceBillingScope },
  plugins: [
    createOrganizationPlugin({
      baseURL: origin,
      sendInvitationEmail: async () => {},
    }),
    createBillingPlugin({
      stripeClient: stripe,
      webhookSecret: secret,
      proPriceId,
      teamPriceId,
      createCustomerOnSignUp: false,
    }),
  ],
});
const userIds: string[] = [];
const orgIds: string[] = [];
const customerIds = new Set<string>();
const subscriptionIds: string[] = [];
const checkoutIds: string[] = [];

async function signup() {
  const id = crypto.randomUUID();
  const { response, headers } = await auth.api.signUpEmail({
    body: {
      email: `${id}@example.com`,
      name: "Billing fixture",
      password: "billing-fixture-password",
    },
    returnHeaders: true,
  });
  userIds.push(response.user.id);
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.id, response.user.id));
  return {
    id: response.user.id,
    headers: new Headers({
      origin,
      cookie: headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    }),
  };
}

async function webhook(type: string, object: object) {
  const payload = JSON.stringify({
    id: `evt_${crypto.randomUUID()}`,
    object: "event",
    type,
    data: { object },
    livemode: false,
  });
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
  });
  const response = await auth.handler(
    new Request(`${origin}/api/auth/stripe/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      body: payload,
    }),
  );
  assert.equal(response.status, 200, await response.text());
}

async function checkout(
  headers: Headers,
  scope:
    | { plan: "pro"; customerType: "user" }
    | { plan: "team"; customerType: "organization"; referenceId: string },
) {
  const result = await auth.api.upgradeSubscription({
    headers,
    body: {
      ...scope,
      successUrl: "/settings/billing",
      cancelUrl: "/settings/billing",
      disableRedirect: true,
      seats: scope.plan === "team" ? 999 : 1,
    },
  });
  assert(result.url);
  const id = result.url.match(/cs_test_[^#]+/)?.[0];
  assert(id, "Checkout returned a sandbox session");
  checkoutIds.push(id);
  const session = await stripe.checkout.sessions.retrieve(id, {
    expand: ["line_items"],
  });
  const customerId =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  assert(customerId);
  customerIds.add(customerId);
  assert.equal(session.line_items?.data.length, 1, "No extra base fee");
  assert.equal(
    session.line_items.data[0]?.price?.id,
    scope.plan === "team" ? teamPriceId : proPriceId,
  );
  assert.equal(
    session.line_items.data[0]?.quantity,
    1,
    "Team seats come from membership, ignoring client quantity",
  );
  assert.equal(
    session.client_reference_id,
    scope.plan === "team" ? scope.referenceId : userIds[0],
  );
  return { session, customerId };
}

async function activate(
  session: Stripe.Checkout.Session,
  customerId: string,
  price: string,
) {
  const method = await stripe.paymentMethods.attach("pm_card_visa", {
    customer: customerId,
  });
  const subscription = await stripe.subscriptions.create({
    customer: customerId,
    default_payment_method: method.id,
    items: [{ price, quantity: 1 }],
    metadata: session.metadata ?? {},
  });
  subscriptionIds.push(subscription.id);
  assert.equal(subscription.status, "active");
  // Use Stripe's real sandbox subscription with a signed completion fixture.
  // Hosted form payment and webhook delivery are separate manual checks.
  await webhook("checkout.session.completed", {
    ...session,
    subscription: subscription.id,
    status: "complete",
  });
  await webhook("customer.subscription.created", subscription);
  return subscription;
}

try {
  const owner = await signup();
  const teammate = await signup();
  assert.equal(await compilePlan(db, teammate.id), "free");
  await assert.rejects(aiEntitlement(db, teammate.id));
  const personal = await checkout(owner.headers, {
    plan: "pro",
    customerType: "user",
  });
  const personalSub = await activate(
    personal.session,
    personal.customerId,
    proPriceId,
  );
  assert.equal(await compilePlan(db, owner.id), "pro");
  assert.equal(
    (await aiEntitlement(db, owner.id)).subscriptionId,
    personalSub.id,
  );

  const org = await auth.api.createOrganization({
    headers: owner.headers,
    body: {
      name: "Sandbox billing fixture",
      slug: `billing-${crypto.randomUUID()}`,
    },
  });
  assert(org);
  orgIds.push(org.id);
  const shared = await checkout(owner.headers, {
    plan: "team",
    customerType: "organization",
    referenceId: org.id,
  });
  assert.notEqual(
    shared.customerId,
    personal.customerId,
    "Organization and personal payers stay separate",
  );
  const teamSub = await activate(
    shared.session,
    shared.customerId,
    teamPriceId,
  );
  assert.equal(await compilePlan(db, owner.id), "team");
  const portal = await auth.api.createBillingPortal({
    headers: owner.headers,
    body: {
      customerType: "organization",
      referenceId: org.id,
      returnUrl: "/settings/billing",
    },
  });
  assert(
    new URL(portal.url).hostname === "billing.stripe.com",
    "Owners can open shared billing and invoices",
  );

  assert.equal(
    (await aiEntitlement(db, owner.id, org.id)).customerId,
    shared.customerId,
  );
  const recipient = await db.query.user.findFirst({
    where: { id: teammate.id },
  });
  assert(recipient);
  const invitation = await auth.api.createInvitation({
    headers: owner.headers,
    body: { organizationId: org.id, email: recipient.email, role: "member" },
  });
  let current = await stripe.subscriptions.retrieve(teamSub.id);
  assert.equal(
    current.items.data[0]?.quantity,
    1,
    "Pending invitations do not add seats",
  );
  const accepted = await auth.api.acceptInvitation({
    headers: teammate.headers,
    body: { invitationId: invitation.id },
  });
  current = await stripe.subscriptions.retrieve(teamSub.id);
  assert.equal(
    current.items.data[0]?.quantity,
    2,
    "Accepting an invitation updates Stripe seats",
  );
  await webhook("customer.subscription.updated", current);
  const saved = await db.query.subscription.findMany({
    where: { referenceId: org.id },
  });
  assert.equal(
    saved.length,
    1,
    "Webhook replay does not duplicate subscriptions",
  );
  assert.equal(saved[0]?.seats, 2);
  assert.equal(saved[0]?.plan, "team");
  assert.equal(await compilePlan(db, teammate.id), "team");
  assert.equal(
    (await aiEntitlement(db, teammate.id)).customerId,
    shared.customerId,
  );
  await assert.rejects(
    auth.api.createBillingPortal({
      headers: teammate.headers,
      body: {
        customerType: "organization",
        referenceId: org.id,
        returnUrl: "/settings/billing",
      },
    }),
  );
  await auth.api.removeMember({
    headers: owner.headers,
    body: { organizationId: org.id, memberIdOrEmail: accepted.member.id },
  });
  current = await stripe.subscriptions.retrieve(teamSub.id);
  assert.equal(
    current.items.data[0]?.quantity,
    1,
    "Removing a member updates Stripe seats",
  );
  assert.equal(await compilePlan(db, teammate.id), "free");
  await assert.rejects(aiEntitlement(db, teammate.id));
  await stripe.subscriptions.cancel(teamSub.id);
  await webhook(
    "customer.subscription.deleted",
    await stripe.subscriptions.retrieve(teamSub.id),
  );
  assert.equal(
    await compilePlan(db, owner.id),
    "pro",
    "Personal subscription survives Team cancellation",
  );
  assert.equal(
    (await aiEntitlement(db, owner.id)).customerId,
    personal.customerId,
  );
  await stripe.subscriptions.cancel(personalSub.id);
  await webhook(
    "customer.subscription.deleted",
    await stripe.subscriptions.retrieve(personalSub.id),
  );
  assert.equal(await compilePlan(db, owner.id), "free");
  await assert.rejects(aiEntitlement(db, owner.id));
  console.info(
    "Billing passed: real sandbox checkout and subscriptions, signed webhook processing, seat additions/removals, payer isolation, compile/AI entitlement and cancellation.",
  );
} finally {
  for (const id of checkoutIds) {
    const checkout = await stripe.checkout.sessions.retrieve(id);
    if (checkout.status === "open") await stripe.checkout.sessions.expire(id);
  }
  for (const id of subscriptionIds) {
    const subscription = await stripe.subscriptions.retrieve(id);
    if (subscription.status !== "canceled")
      await stripe.subscriptions.cancel(id);
  }
  for (const id of customerIds) await stripe.customers.del(id);
  await db
    .delete(schema.subscription)
    .where(inArray(schema.subscription.referenceId, [...userIds, ...orgIds]));
  if (orgIds.length)
    await db
      .delete(schema.organization)
      .where(inArray(schema.organization.id, orgIds));
  if (userIds.length)
    await db.delete(schema.user).where(inArray(schema.user.id, userIds));
  await db.$client.end();
}
