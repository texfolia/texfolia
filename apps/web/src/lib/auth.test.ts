import { expect, test } from "bun:test";
import assert from "node:assert/strict";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Stripe from "stripe";

import { loginSearchSchema } from "../routes/login";
import { createBillingPlugin, createOrganizationPlugin } from "./auth";
import { enforceBillingScope } from "./billing.server";
import type { sendEmail } from "./email";

function createTestAuth() {
  const emails: Parameters<typeof sendEmail>[0][] = [];
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "organization-integration-test-secret-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
      subscription: [],
    }),
    emailAndPassword: { enabled: true },
    hooks: { before: enforceBillingScope },
    plugins: [
      createOrganizationPlugin({
        baseURL: "http://localhost:3000",
        sendInvitationEmail: async (email) => {
          emails.push(email);
        },
      }),
      createBillingPlugin({
        stripeClient: new Stripe("sk_test_organization_integration"),
        webhookSecret: "whsec_organization_integration",
        createCustomerOnSignUp: false,
        proPriceId: "price_pro",
        teamPriceId: "price_team",
      }),
    ],
  });
  return { auth, emails };
}

async function createUser(
  auth: ReturnType<typeof createTestAuth>["auth"],
  email: string,
  verified = true,
) {
  const { response, headers } = await auth.api.signUpEmail({
    body: { email, name: email, password: "test-password-123456" },
    returnHeaders: true,
  });
  if (verified) {
    const ctx = await auth.$context;
    await ctx.internalAdapter.updateUser(response.user.id, {
      emailVerified: true,
    });
  }
  return {
    user: response.user,
    headers: new Headers({
      cookie: headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
      origin: "http://localhost:3000",
    }),
  };
}

test("organizations are optional and switching organizations preserves the personal account", async () => {
  const { auth } = createTestAuth();
  const owner = await createUser(auth, "owner@example.com");
  expect(await auth.api.listOrganizations({ headers: owner.headers })).toEqual(
    [],
  );

  const organization = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Research group", slug: "research-group" },
  });
  assert(organization);
  expect(organization.id).not.toBe(owner.user.id);
  const session = await auth.api.getSession({ headers: owner.headers });
  expect(session?.user.id).toBe(owner.user.id);
  expect(session?.session.activeOrganizationId).toBe(organization.id);

  await auth.api.setActiveOrganization({
    headers: owner.headers,
    body: { organizationId: null },
  });
  const personalSession = await auth.api.getSession({ headers: owner.headers });
  expect(personalSession?.user.id).toBe(owner.user.id);
  expect(personalSession?.session.activeOrganizationId).toBeNull();
  expect(
    await auth.api.listOrganizations({ headers: owner.headers }),
  ).toHaveLength(1);
});

test("emailed invitations require the verified recipient and preserve their personal identity", async () => {
  const { auth, emails } = createTestAuth();
  const owner = await createUser(auth, "owner@example.com");
  const recipient = await createUser(auth, "recipient@example.com", false);
  const organization = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Research group", slug: "research-group" },
  });
  assert(organization);
  const invitation = await auth.api.createInvitation({
    headers: owner.headers,
    body: {
      email: recipient.user.email,
      organizationId: organization.id,
      role: "member",
    },
  });
  expect(emails).toHaveLength(1);
  expect(emails[0]?.to).toBe(recipient.user.email);
  expect(emails[0]?.text).toContain(
    `http://localhost:3000/accept-invitation/${invitation.id}`,
  );
  await expect(
    auth.api.acceptInvitation({
      headers: owner.headers,
      body: { invitationId: invitation.id },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    auth.api.acceptInvitation({
      headers: recipient.headers,
      body: { invitationId: invitation.id },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });

  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(recipient.user.id, {
    emailVerified: true,
  });
  const details = await auth.api.getInvitation({
    headers: recipient.headers,
    query: { id: invitation.id },
  });
  expect(details.organizationName).toBe("Research group");
  const { member: membership } = await auth.api.acceptInvitation({
    headers: recipient.headers,
    body: { invitationId: invitation.id },
  });
  expect(membership.userId).toBe(recipient.user.id);
  expect(membership.organizationId).toBe(organization.id);
  const session = await auth.api.getSession({ headers: recipient.headers });
  expect(session?.user.id).toBe(recipient.user.id);
});

test("organization billing requires an explicit organization scope and current owner/admin membership", async () => {
  const { auth } = createTestAuth();
  const owner = await createUser(auth, "owner@example.com");
  const teammate = await createUser(auth, "teammate@example.com");
  const organization = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Research group", slug: "research-group" },
  });
  assert(organization);
  const ctx = await auth.$context;
  for (const referenceId of [owner.user.id, organization.id]) {
    await ctx.adapter.create({
      model: "subscription",
      data: { referenceId, plan: "pro", status: "active" },
    });
  }

  const personal = await auth.api.listActiveSubscriptions({
    headers: owner.headers,
    query: {},
  });
  expect(personal.map((subscription) => subscription.referenceId)).toEqual([
    owner.user.id,
  ]);
  const organizational = await auth.api.listActiveSubscriptions({
    headers: owner.headers,
    query: { customerType: "organization", referenceId: organization.id },
  });
  expect(
    organizational.map((subscription) => subscription.referenceId),
  ).toEqual([organization.id]);
  await expect(
    auth.api.listActiveSubscriptions({
      headers: owner.headers,
      query: { referenceId: organization.id },
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
  await expect(
    auth.api.listActiveSubscriptions({
      headers: teammate.headers,
      query: { customerType: "organization", referenceId: organization.id },
    }),
  ).rejects.toMatchObject({ statusCode: 401 });

  const membership = await auth.api.addMember({
    body: {
      userId: teammate.user.id,
      organizationId: organization.id,
      role: "admin",
    },
  });
  assert(membership);
  expect(
    await auth.api.listActiveSubscriptions({
      headers: teammate.headers,
      query: { customerType: "organization", referenceId: organization.id },
    }),
  ).toHaveLength(1);
  await expect(
    auth.api.listActiveSubscriptions({
      headers: teammate.headers,
      query: { referenceId: owner.user.id },
    }),
  ).rejects.toMatchObject({ statusCode: 401 });

  await auth.api.updateMemberRole({
    headers: owner.headers,
    body: {
      memberId: membership.id,
      organizationId: organization.id,
      role: "member",
    },
  });
  await expect(
    auth.api.listActiveSubscriptions({
      headers: teammate.headers,
      query: { customerType: "organization", referenceId: organization.id },
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
});

test("members cannot change organization billing through POST endpoints", async () => {
  const { auth } = createTestAuth();
  const owner = await createUser(auth, "owner@example.com");
  const teammate = await createUser(auth, "teammate@example.com");
  const organization = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Research group", slug: "research-group" },
  });
  assert(organization);
  await auth.api.addMember({
    body: {
      userId: teammate.user.id,
      organizationId: organization.id,
      role: "member",
    },
  });
  const headers = new Headers(teammate.headers);
  headers.set("content-type", "application/json");
  for (const action of ["upgrade", "cancel", "restore", "billing-portal"]) {
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth/subscription/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          customerType: "organization",
          referenceId: organization.id,
          plan: "team",
          successUrl: "/projects",
          cancelUrl: "/pricing",
          returnUrl: "/projects",
        }),
      }),
    );
    expect(response.status).toBe(401);
  }
});

test("login returns to invitation paths and rejects external redirect targets", () => {
  const redirectTo = "/accept-invitation/invitation-id";
  expect(loginSearchSchema.parse({ redirectTo }).redirectTo).toBe(redirectTo);
  expect(loginSearchSchema.parse({}).redirectTo).toBeUndefined();
  for (const target of [
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/\n/example.com",
    "javascript:alert(1)",
  ]) {
    expect(loginSearchSchema.parse({ redirectTo: target }).redirectTo).toBe(
      "/projects",
    );
  }
});

test("billing rejects personal Team, organization Pro, annual and multi-seat personal checkout", async () => {
  const { auth } = createTestAuth();
  const owner = await createUser(auth, "billing-scope@example.com");
  const org = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Scope", slug: "scope" },
  });
  assert(org);
  for (const body of [
    { plan: "team" },
    { plan: "TEAM" },
    { plan: "Pro", customerType: "organization", referenceId: org.id },
    { plan: "team", customerType: "user" },
    { plan: "pro", customerType: "organization", referenceId: org.id },
    { plan: "pro", annual: true },
    { plan: "pro", seats: 2 },
  ] as const) {
    await expect(
      auth.api.upgradeSubscription({
        headers: owner.headers,
        body: { ...body, successUrl: "/billing", cancelUrl: "/pricing" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  }
});
