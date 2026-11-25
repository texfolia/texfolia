import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Stripe from "stripe";

import { createBillingPlugin } from "#/lib/billing/server";
import type { EmailMessage } from "#/lib/email";
import { loginSearch } from "#/routes/login/route";

import {
  beforeAuth,
  createAfterAuth,
  createOrganizationPlugin,
  sessionOptions,
} from "./auth";
import { requestPrincipal } from "./request-principal.server";

function createTestAuth() {
  const emails: EmailMessage[] = [];
  const stripeClient = new Stripe("sk_test_organization_integration");
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
    session: sessionOptions,
    hooks: {
      before: beforeAuth,
      // Without live channels, the database is not read.
      after: createAfterAuth({ db: undefined as never, live: undefined }),
    },
    user: {
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async () => {},
      },
    },
    plugins: [
      createOrganizationPlugin({
        baseURL: "http://localhost:3000",
        sendInvitationEmail: async (email) => {
          emails.push(email);
        },
      }),
      createBillingPlugin({
        stripeClient,
        webhookSecret: "whsec_organization_integration",
        createCustomerOnSignUp: false,
        proPriceId: "price_pro",
        teamPriceId: "price_team",
      }),
    ],
  });
  return { auth, emails, stripeClient };
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
  // These headers keep the cookies from sign-up, which a browser would replace.
  const current = {
    headers: owner.headers,
    query: { disableCookieCache: true },
  };
  const session = await auth.api.getSession(current);
  expect(session?.user.id).toBe(owner.user.id);
  expect(session?.session.activeOrganizationId).toBe(organization.id);

  await auth.api.setActiveOrganization({
    headers: owner.headers,
    body: { organizationId: null },
  });
  const personalSession = await auth.api.getSession(current);
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
  expect(loginSearch({ redirectTo }).redirectTo).toBe(redirectTo);
  expect(loginSearch({}).redirectTo).toBeUndefined();
  for (const target of [
    "https://example.com",
    "//example.com",
    "/\\example.com",
    "/\n/example.com",
    "javascript:alert(1)",
  ]) {
    expect(loginSearch({ redirectTo: target }).redirectTo).toBe("/projects");
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

test("a revoked session keeps working only where the cached cookie is trusted", async () => {
  const { auth } = createTestAuth();
  const owner = await createUser(auth, "revoked@example.com");
  expect(owner.headers.get("cookie")).toContain("session_data");
  const request = (headers: Record<string, string> = {}) =>
    new Request("http://localhost:3000/api/projects/x", {
      headers: { ...Object.fromEntries(owner.headers), ...headers },
    });
  const principal = (request: Request) =>
    requestPrincipal({
      request,
      auth: auth as never,
      db: undefined as never,
      projectId: "x",
    });
  expect(await principal(request({ Upgrade: "websocket" }))).toMatchObject({
    userId: owner.user.id,
  });

  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(owner.user.id);
  expect(await principal(request())).toMatchObject({ userId: owner.user.id });
  expect(await principal(request({ Upgrade: "websocket" }))).toBeNull();
  for (const path of ["/organization/create", "/subscription/upgrade"]) {
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: {
          ...Object.fromEntries(owner.headers),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          path === "/organization/create"
            ? { name: "Revoked", slug: "revoked" }
            : { plan: "pro", successUrl: "/", cancelUrl: "/" },
        ),
      }),
    );
    expect([path, response.status]).toEqual([path, 401]);
  }
});

test("reading the session for a WebSocket upgrade sets no cookie", async () => {
  const { auth } = createTestAuth();
  const owner = await createUser(auth, "upgrade@example.com");
  // As when the cached session has expired.
  const token = owner.headers
    .get("cookie")!
    .split("; ")
    .filter((cookie) => !cookie.includes("session_data"))
    .join("; ");
  const read = (query: object) =>
    auth.api.getSession({
      headers: new Headers({ cookie: token }),
      query,
      returnHeaders: true,
    });
  expect((await read({})).headers.getSetCookie()).not.toEqual([]);
  const upgrade = await read({
    disableCookieCache: true,
    disableRefresh: true,
  });
  expect(upgrade.response?.user.id).toBe(owner.user.id);
  expect(upgrade.headers.getSetCookie()).toEqual([]);
});

async function createTeam() {
  const test = createTestAuth();
  const { auth } = test;
  const owner = await createUser(auth, "owner@example.com");
  const organization = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Research group", slug: "research-group" },
  });
  assert(organization);
  const organizationId = organization.id;
  const join = async (email: string, role: "admin" | "member") => {
    const joined = await createUser(auth, email);
    const member = await auth.api.addMember({
      body: { userId: joined.user.id, organizationId, role },
    });
    assert(member);
    return { ...joined, memberId: member.id };
  };
  return { ...test, owner, organization, organizationId, join };
}

const forbidden = { statusCode: 403 };

test("only owners change roles, and promote other owners", async () => {
  const { auth, owner, organizationId, join } = await createTeam();
  const admin = await join("admin@example.com", "admin");
  const member = await join("member@example.com", "member");
  const setRole = (headers: Headers, memberId: string, role: string) =>
    auth.api.updateMemberRole({
      headers,
      body: { organizationId, memberId, role },
    });
  for (const [headers, memberId, role] of [
    [admin.headers, member.memberId, "admin"],
    [admin.headers, admin.memberId, "owner"],
    [admin.headers, admin.memberId, "member"],
    [member.headers, member.memberId, "admin"],
  ] as const)
    await expect(setRole(headers, memberId, role)).rejects.toMatchObject(
      forbidden,
    );
  expect(await setRole(owner.headers, member.memberId, "owner")).toMatchObject({
    role: "owner",
  });
  expect(await setRole(member.headers, admin.memberId, "member")).toMatchObject(
    { role: "member" },
  );
});

test("admins invite and remove members, and only owners invite and remove admins", async () => {
  const { auth, owner, organizationId, join } = await createTeam();
  const admin = await join("admin@example.com", "admin");
  const other = await join("other@example.com", "admin");
  const member = await join("member@example.com", "member");
  const invite = (
    headers: Headers,
    role: "member" | "admin" | "owner" | ("member" | "admin")[],
  ) =>
    auth.api.createInvitation({
      headers,
      body: { organizationId, email: `${crypto.randomUUID()}@e.com`, role },
    });
  await invite(admin.headers, "member");
  for (const role of ["admin", "owner", ["member", "admin"]] as const)
    await expect(
      invite(
        admin.headers,
        role === "admin" || role === "owner" ? role : [...role],
      ),
    ).rejects.toMatchObject(forbidden);
  expect(await invite(owner.headers, "admin")).toMatchObject({ role: "admin" });
  await invite(owner.headers, "owner");

  const remove = (headers: Headers, memberIdOrEmail: string) =>
    auth.api.removeMember({
      headers,
      body: { organizationId, memberIdOrEmail },
    });
  for (const target of [other.memberId, other.user.email, "OTHER@example.com"])
    await expect(remove(admin.headers, target)).rejects.toThrow();
  await expect(remove(admin.headers, owner.user.email)).rejects.toMatchObject(
    forbidden,
  );
  await expect(remove(member.headers, other.memberId)).rejects.toThrow();
  await remove(admin.headers, member.memberId);
  await remove(owner.headers, other.memberId);
  await remove(admin.headers, admin.memberId);
});

test("owners and admins rename an organization, and only owners delete it", async () => {
  const { auth, owner, organizationId, join } = await createTeam();
  const admin = await join("admin@example.com", "admin");
  const member = await join("member@example.com", "member");
  const rename = (headers: Headers) =>
    auth.api.updateOrganization({
      headers,
      body: { organizationId, data: { name: "Renamed" } },
    });
  await expect(rename(member.headers)).rejects.toMatchObject(forbidden);
  expect(await rename(admin.headers)).toMatchObject({ name: "Renamed" });
  for (const { headers } of [admin, member])
    await expect(
      auth.api.deleteOrganization({ headers, body: { organizationId } }),
    ).rejects.toMatchObject(forbidden);
  await auth.api.deleteOrganization({
    headers: owner.headers,
    body: { organizationId },
  });
});

test("leaving updates the paid seats, and the last owner cannot leave", async () => {
  const { auth, stripeClient, owner, organization, organizationId, join } =
    await createTeam();
  const member = await join("member@example.com", "member");
  const ctx = await auth.$context;
  await ctx.adapter.update({
    model: "organization",
    where: [{ field: "id", value: organization.id }],
    update: { stripeCustomerId: "cus_team" },
  });
  await ctx.adapter.create({
    model: "subscription",
    data: {
      referenceId: organizationId,
      plan: "team",
      status: "active",
      stripeSubscriptionId: "sub_team",
    },
  });
  spyOn(stripeClient.subscriptions, "retrieve").mockImplementation(
    (async () => ({
      id: "sub_team",
      status: "active",
      items: { data: [{ id: "si", price: { id: "price_team" }, quantity: 2 }] },
    })) as never,
  );
  const update = spyOn(stripeClient.subscriptions, "update").mockImplementation(
    (async () => ({})) as never,
  );
  await auth.api.leaveOrganization({
    headers: member.headers,
    body: { organizationId },
  });
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]?.slice(0, 2)).toMatchObject([
    "sub_team",
    { items: [{ id: "si", quantity: 1 }] },
  ]);
  await expect(
    auth.api.leaveOrganization({
      headers: owner.headers,
      body: { organizationId },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  expect(update).toHaveBeenCalledTimes(1);
});

test("an organization's only owner cannot delete their account", async () => {
  const { auth, owner, organizationId, join } = await createTeam();
  const admin = await join("admin@example.com", "admin");
  const request = (headers: Headers) =>
    auth.api.deleteUser({ headers, body: {} });
  await expect(request(owner.headers)).rejects.toThrow(
    /only owner of Research group/,
  );
  // The emailed link is checked too: it may predate the organization.
  const confirm = await auth.handler(
    new Request(
      "http://localhost:3000/api/auth/delete-user/callback?token=any&callbackURL=/",
      { headers: owner.headers },
    ),
  );
  expect(confirm.status).toBe(302);
  expect(confirm.headers.get("location")).toBe(
    "/settings/account?deletion=blocked",
  );
  expect(await request(admin.headers)).toMatchObject({ success: true });
  await auth.api.updateMemberRole({
    headers: owner.headers,
    body: { organizationId, memberId: admin.memberId, role: "owner" },
  });
  expect(await request(owner.headers)).toMatchObject({ success: true });
});
