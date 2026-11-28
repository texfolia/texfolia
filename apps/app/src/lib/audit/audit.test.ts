import { expect, test } from "bun:test";
import assert from "node:assert/strict";

import type { Db } from "@texfolia/db";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Stripe from "stripe";

import {
  beforeAuth,
  createAfterAuth,
  createOrganizationPlugin,
  sessionOptions,
} from "#/lib/auth/auth";
import { createBillingPlugin } from "#/lib/billing/stripe";
import {
  createShareLink,
  revokeShareLink,
} from "#/lib/sharing/project-share-links.server";

import { describeAuditEvent, sanitizeAuditMetadata } from "./audit";
import {
  AuditAccessError,
  listOrganizationAuditEvents,
  type OrganizationAuditEventInput,
} from "./audit.server";

function createTestAuditAuth() {
  const events: OrganizationAuditEventInput[] = [];
  const audit = async (event: OrganizationAuditEventInput) => {
    events.push({
      ...event,
      metadata: sanitizeAuditMetadata(event.metadata),
    });
  };
  const stripeClient = new Stripe("sk_test_audit_log_secret_key");
  const webhookSecret = "whsec_audit_log_webhook_secret_12345";
  const customerToOrg = new Map<string, string>();
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "audit-log-integration-test-secret-at-least-32-chars",
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
    session: sessionOptions,
    hooks: {
      before: beforeAuth,
      after: createAfterAuth({
        db: undefined as never,
        live: undefined,
        audit,
      }),
    },
    plugins: [
      createOrganizationPlugin({
        baseURL: "http://localhost:3000",
        sendInvitationEmail: async () => {},
        audit,
      }),
      createBillingPlugin({
        stripeClient,
        webhookSecret,
        createCustomerOnSignUp: false,
        proPriceId: "price_pro",
        teamPriceId: "price_team",
        onAuditEvent: audit,
        resolveOrganizationByCustomerId: async (customerId) =>
          customerToOrg.get(customerId) ?? null,
      }),
    ],
  });
  return { auth, events, stripeClient, webhookSecret, customerToOrg };
}

async function createVerifiedUser(
  auth: ReturnType<typeof createTestAuditAuth>["auth"],
  email: string,
) {
  const { response, headers } = await auth.api.signUpEmail({
    body: {
      email,
      name: email.split("@")[0] ?? email,
      password: "test-password-123456",
    },
    returnHeaders: true,
  });
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(response.user.id, {
    emailVerified: true,
  });
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

test("sanitizeAuditMetadata strips secrets, tokens, and raw share URLs while keeping safe Stripe IDs", () => {
  const rawToken = "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-";
  const cleaned = sanitizeAuditMetadata({
    projectId: "proj-1",
    projectName: "Paper",
    role: "viewer",
    stripeSubscriptionId: "sub_12345",
    stripeCustomerId: "cus_67890",
    stripeInvoiceId: "in_abcde",
    token: rawToken,
    shareToken: rawToken,
    tokenHash: "sha256-hash",
    accessToken: "ya29.secret",
    webhookSecret: "whsec_live_1234567890",
    password: "super-secret-password",
    apiKey: "sk_live_9876543210",
    nested: {
      ok: true,
      clientSecret: "secret_value",
      leakedUrl: `https://app.texfolia.com/share/${rawToken}`,
      leakedKey: "sk_test_1234567890abcdef",
      leakedWebhook: "whsec_abcdef123456",
      leakedBearer: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    },
  });

  expect(cleaned).toEqual({
    projectId: "proj-1",
    projectName: "Paper",
    role: "viewer",
    stripeSubscriptionId: "sub_12345",
    stripeCustomerId: "cus_67890",
    stripeInvoiceId: "in_abcde",
    nested: { ok: true },
  });
  const serialized = JSON.stringify(cleaned);
  expect(serialized).not.toContain(rawToken);
  expect(serialized).not.toContain("whsec_");
  expect(serialized).not.toContain("sk_live_");
  expect(serialized).not.toContain("sk_test_");
  expect(serialized).not.toContain("Bearer");
  expect(serialized).not.toContain("super-secret-password");
});

test("records invites, member role/removal/leave, org rename, and team changes with accurate actors", async () => {
  const { auth, events } = createTestAuditAuth();
  const owner = await createVerifiedUser(auth, "owner@example.com");
  const alice = await createVerifiedUser(auth, "alice@example.com");
  const bob = await createVerifiedUser(auth, "bob@example.com");
  const carol = await createVerifiedUser(auth, "carol@example.com");

  const org = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Physics Lab", slug: "physics-lab" },
  });
  assert(org);

  // Rename org
  await auth.api.updateOrganization({
    headers: owner.headers,
    body: { organizationId: org.id, data: { name: "Quantum Lab" } },
  });

  // Invite Alice and accept
  const aliceInvite = await auth.api.createInvitation({
    headers: owner.headers,
    body: { organizationId: org.id, email: alice.user.email, role: "member" },
  });
  const { member: aliceMember } = await auth.api.acceptInvitation({
    headers: alice.headers,
    body: { invitationId: aliceInvite.id },
  });

  // Invite Bob and cancel
  const bobInvite = await auth.api.createInvitation({
    headers: owner.headers,
    body: { organizationId: org.id, email: bob.user.email, role: "member" },
  });
  await auth.api.cancelInvitation({
    headers: owner.headers,
    body: { invitationId: bobInvite.id },
  });

  // Invite Carol and reject
  const carolInvite = await auth.api.createInvitation({
    headers: owner.headers,
    body: { organizationId: org.id, email: carol.user.email, role: "member" },
  });
  await auth.api.rejectInvitation({
    headers: carol.headers,
    body: { invitationId: carolInvite.id },
  });

  // Promote Alice from member -> admin (actor must be owner, not Alice!)
  await auth.api.updateMemberRole({
    headers: owner.headers,
    body: { organizationId: org.id, memberId: aliceMember.id, role: "admin" },
  });

  // Create team, rename team, add/remove member, delete team
  const createdTeam = await auth.api.createTeam({
    headers: owner.headers,
    body: { organizationId: org.id, name: "Reviewers" },
  });
  await auth.api.updateTeam({
    headers: owner.headers,
    body: {
      teamId: createdTeam.id,
      data: { organizationId: org.id, name: "Senior Reviewers" },
    },
  });
  await auth.api.addTeamMember({
    headers: owner.headers,
    body: {
      organizationId: org.id,
      teamId: createdTeam.id,
      userId: alice.user.id,
    },
  });
  await auth.api.removeTeamMember({
    headers: owner.headers,
    body: {
      organizationId: org.id,
      teamId: createdTeam.id,
      userId: alice.user.id,
    },
  });
  await auth.api.removeTeam({
    headers: owner.headers,
    body: { organizationId: org.id, teamId: createdTeam.id },
  });

  // Add Bob directly, then Bob leaves; remove Alice by owner
  await auth.api.addMember({
    body: { organizationId: org.id, userId: bob.user.id, role: "member" },
  });
  await auth.api.leaveOrganization({
    headers: bob.headers,
    body: { organizationId: org.id },
  });
  await auth.api.removeMember({
    headers: owner.headers,
    body: { organizationId: org.id, memberIdOrEmail: aliceMember.id },
  });

  const actions = events.map((e) => e.action);
  expect(actions).toContain("organization.updated");
  expect(actions).toContain("invitation.created");
  expect(actions).toContain("invitation.accepted");
  expect(actions).toContain("invitation.canceled");
  expect(actions).toContain("invitation.rejected");
  expect(actions).toContain("member.added");
  expect(actions).toContain("member.role_updated");
  expect(actions).toContain("member.left");
  expect(actions).toContain("member.removed");
  expect(actions).toContain("team.created");
  expect(actions).toContain("team.updated");
  expect(actions).toContain("team.member_added");
  expect(actions).toContain("team.member_removed");
  expect(actions).toContain("team.deleted");

  // Verify actors are the performing user (not the target user)
  const roleEvent = events.find((e) => e.action === "member.role_updated");
  expect(roleEvent?.actorUserId).toBe(owner.user.id);
  expect(roleEvent?.metadata).toMatchObject({
    targetUserId: alice.user.id,
    targetEmail: alice.user.email,
    previousRole: "member",
    role: "admin",
  });

  const teamAddEvent = events.find((e) => e.action === "team.member_added");
  expect(teamAddEvent?.actorUserId).toBe(owner.user.id);
  expect(teamAddEvent?.metadata).toMatchObject({
    teamName: "Senior Reviewers",
    targetUserId: alice.user.id,
  });

  const teamRemoveEvent = events.find(
    (e) => e.action === "team.member_removed",
  );
  expect(teamRemoveEvent?.actorUserId).toBe(owner.user.id);

  const removeMemberEvent = events.find((e) => e.action === "member.removed");
  expect(removeMemberEvent?.actorUserId).toBe(owner.user.id);
  expect(removeMemberEvent?.metadata).toMatchObject({
    targetUserId: alice.user.id,
  });

  const leftEvent = events.find((e) => e.action === "member.left");
  expect(leftEvent?.actorUserId).toBe(bob.user.id);
});

test("records organization billing webhook events and omits secrets", async () => {
  const { auth, events, stripeClient, webhookSecret, customerToOrg } =
    createTestAuditAuth();
  const owner = await createVerifiedUser(auth, "billing-owner@example.com");
  const org = await auth.api.createOrganization({
    headers: owner.headers,
    body: { name: "Billing Org", slug: "billing-org" },
  });
  assert(org);
  const ctx = await auth.$context;
  await ctx.adapter.update({
    model: "organization",
    where: [{ field: "id", value: org.id }],
    update: { stripeCustomerId: "cus_org_1" },
  });
  customerToOrg.set("cus_org_1", org.id);

  const sendWebhook = async (payloadObj: Record<string, unknown>) => {
    const payload = JSON.stringify(payloadObj);
    const sig = await stripeClient.webhooks.generateTestHeaderStringAsync({
      payload,
      secret: webhookSecret,
    });
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/stripe/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": sig,
        },
        body: payload,
      }),
    );
    expect(res.status).toBe(200);
  };

  const now = Math.floor(Date.now() / 1000);
  // 1. Subscription created
  await sendWebhook({
    id: "evt_sub_created",
    object: "event",
    type: "customer.subscription.created",
    data: {
      object: {
        id: "sub_org_1",
        object: "subscription",
        customer: "cus_org_1",
        status: "active",
        cancel_at_period_end: false,
        metadata: {},
        items: {
          data: [
            {
              price: { id: "price_team", recurring: { interval: "month" } },
              quantity: 3,
              current_period_start: now,
              current_period_end: now + 2_592_000,
            },
          ],
        },
      },
    },
  });

  // 2. Seat quantity updated
  await sendWebhook({
    id: "evt_sub_seats",
    object: "event",
    type: "customer.subscription.updated",
    data: {
      previous_attributes: { items: {} },
      object: {
        id: "sub_org_1",
        object: "subscription",
        customer: "cus_org_1",
        status: "active",
        cancel_at_period_end: false,
        metadata: {},
        items: {
          data: [
            {
              price: { id: "price_team", recurring: { interval: "month" } },
              quantity: 5,
              current_period_start: now,
              current_period_end: now + 2_592_000,
            },
          ],
        },
      },
    },
  });

  // 3. Cancel scheduled
  await sendWebhook({
    id: "evt_sub_cancel",
    object: "event",
    type: "customer.subscription.updated",
    data: {
      previous_attributes: { cancel_at_period_end: false },
      object: {
        id: "sub_org_1",
        object: "subscription",
        customer: "cus_org_1",
        status: "active",
        cancel_at_period_end: true,
        cancellation_details: { reason: "cancellation_requested" },
        metadata: {},
        items: {
          data: [
            {
              price: { id: "price_team", recurring: { interval: "month" } },
              quantity: 5,
              current_period_start: now,
              current_period_end: now + 2_592_000,
            },
          ],
        },
      },
    },
  });

  // 4. Payment failed
  await sendWebhook({
    id: "evt_inv_failed",
    object: "event",
    type: "invoice.payment_failed",
    data: {
      object: {
        id: "in_org_1",
        object: "invoice",
        customer: "cus_org_1",
        amount_due: 6000,
        currency: "usd",
        attempt_count: 1,
      },
    },
  });

  // 5. Subscription deleted
  await sendWebhook({
    id: "evt_sub_deleted",
    object: "event",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_org_1",
        object: "subscription",
        customer: "cus_org_1",
        status: "canceled",
        cancel_at_period_end: true,
        metadata: {},
        items: {
          data: [
            {
              price: { id: "price_team", recurring: { interval: "month" } },
              quantity: 5,
              current_period_start: now,
              current_period_end: now + 2_592_000,
            },
          ],
        },
      },
    },
  });

  const billingEvents = events.filter((e) => e.action.startsWith("billing."));
  expect(billingEvents.map((e) => e.action)).toEqual([
    "billing.subscription_started",
    "billing.seats_updated",
    "billing.subscription_cancel_scheduled",
    "billing.payment_failed",
    "billing.subscription_canceled",
  ]);
  for (const event of billingEvents) {
    expect(event.organizationId).toBe(org.id);
    const json = JSON.stringify(event);
    expect(json).not.toContain(webhookSecret);
    expect(json).not.toContain("sk_test_");
  }
});

test("listOrganizationAuditEvents enforces owner/admin access and rejects regular members and outsiders", async () => {
  const rolesByKey = new Map<string, string>([
    ["org-1:owner-1", "owner"],
    ["org-1:admin-1", "admin"],
    ["org-1:member-1", "member"],
  ]);

  const rows = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "org-1",
      actorUserId: "owner-1",
      actorName: "Owner",
      actorEmail: "owner@example.com",
      action: "invitation.created",
      targetType: "invitation",
      targetId: "inv-1",
      metadata: { email: "new@example.com", role: "member" },
      createdAt: new Date("2026-11-27T12:00:00.000Z"),
    },
  ];

  const fakeDb = {
    query: {
      member: {
        findFirst: async ({
          where,
        }: {
          where: { userId: string; organizationId: string };
        }) => {
          const role = rolesByKey.get(
            `${where.organizationId}:${where.userId}`,
          );
          return role ? { role } : undefined;
        },
      },
    },
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [],
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db;

  // Owner and admin can read
  const ownerResult = await listOrganizationAuditEvents(fakeDb, {
    userId: "owner-1",
    organizationId: "org-1",
  });
  expect(ownerResult.events).toHaveLength(1);
  expect(ownerResult.events[0]?.action).toBe("invitation.created");

  const adminResult = await listOrganizationAuditEvents(fakeDb, {
    userId: "admin-1",
    organizationId: "org-1",
  });
  expect(adminResult.events).toHaveLength(1);

  // Regular member is rejected with 403
  await expect(
    listOrganizationAuditEvents(fakeDb, {
      userId: "member-1",
      organizationId: "org-1",
    }),
  ).rejects.toBeInstanceOf(AuditAccessError);

  // Non-member outsider is rejected with 403
  await expect(
    listOrganizationAuditEvents(fakeDb, {
      userId: "outsider-1",
      organizationId: "org-1",
    }),
  ).rejects.toBeInstanceOf(AuditAccessError);
});

test("org project share-link create and revoke write audit events without storing raw tokens", async () => {
  const insertedAuditRows: Record<string, unknown>[] = [];
  const projectId = "00000000-0000-4000-8000-000000000010";
  const linkId = "00000000-0000-4000-8000-000000000020";
  const orgId = "org-share-1";
  const adminId = "admin-share-1";

  const makeMockDb = (organizationId: string | null) => {
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const isProject =
              table && typeof table === "object" && "organizationRole" in table;
            const isMember =
              table &&
              typeof table === "object" &&
              "organizationId" in table &&
              "userId" in table;
            const isGrant =
              table && typeof table === "object" && "linkId" in table;
            const rows = isProject
              ? [
                  {
                    id: projectId,
                    name: "Org Paper",
                    ownerId: organizationId ? null : adminId,
                    organizationId,
                    organizationRole: "editor",
                    deletedAt: null,
                  },
                ]
              : isMember
                ? organizationId
                  ? [{ role: "admin" }]
                  : []
                : isGrant
                  ? []
                  : [{ count: 0 }];
            return Object.assign(Promise.resolve(rows), {
              for: async () => rows,
              limit: async () => rows,
            });
          },
        }),
      }),
      query: {
        member: {
          findFirst: async () =>
            organizationId ? { role: "admin" } : undefined,
        },
      },
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          if (table && typeof table === "object" && "action" in table) {
            insertedAuditRows.push(values);
            return Promise.resolve();
          }
          return {
            returning: async () => [
              { id: linkId, role: values.role, createdAt: new Date() },
            ],
          };
        },
      }),
      delete: () => ({
        where: () => ({
          returning: async () => [{ id: linkId, role: "viewer" }],
        }),
      }),
    };
    return {
      transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    } as unknown as Db;
  };

  // Org-owned project logs share link creation & revocation without raw token
  const orgDb = makeMockDb(orgId);
  const created = await createShareLink({
    db: orgDb,
    userId: adminId,
    data: { projectId, role: "viewer" },
  });
  expect(created.token.length).toBeGreaterThan(20);

  await revokeShareLink({
    db: orgDb,
    userId: adminId,
    data: { projectId, linkId },
  });

  expect(insertedAuditRows).toHaveLength(2);
  expect(insertedAuditRows[0]).toMatchObject({
    organizationId: orgId,
    actorUserId: adminId,
    action: "project.share_link_created",
    targetType: "share_link",
    targetId: linkId,
    metadata: {
      projectId,
      projectName: "Org Paper",
      role: "viewer",
      emailedRecipient: false,
    },
  });
  expect(insertedAuditRows[1]).toMatchObject({
    organizationId: orgId,
    actorUserId: adminId,
    action: "project.share_link_revoked",
    targetType: "share_link",
    targetId: linkId,
  });
  // Raw share token must never appear in audit rows
  expect(JSON.stringify(insertedAuditRows)).not.toContain(created.token);

  // Personal project (organizationId = null) must NOT write org audit events
  const beforeCount = insertedAuditRows.length;
  const personalDb = makeMockDb(null);
  await createShareLink({
    db: personalDb,
    userId: adminId,
    data: { projectId, role: "viewer" },
  });
  expect(insertedAuditRows.length).toBe(beforeCount);
});

test("describeAuditEvent produces readable summaries", () => {
  expect(
    describeAuditEvent({
      action: "member.role_updated",
      targetType: "member",
      targetId: "m-1",
      metadata: {
        targetEmail: "alice@example.com",
        previousRole: "member",
        role: "admin",
      },
    }),
  ).toEqual({
    summary: "Changed role for alice@example.com",
    detail: "member → admin",
  });

  expect(
    describeAuditEvent({
      action: "billing.payment_failed",
      targetType: "invoice",
      targetId: "in_1",
      metadata: { amountDue: 4500, currency: "usd" },
    }),
  ).toEqual({
    summary: "Subscription payment failed",
    detail: "45.00 USD",
  });
});
