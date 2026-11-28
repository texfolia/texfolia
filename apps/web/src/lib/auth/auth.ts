import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { passkey } from "@better-auth/passkey";
import { type Db } from "@texfolia/db";
import * as schema from "@texfolia/db/schema";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import {
  captcha,
  emailOTP,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { z } from "zod";

import {
  createDbAuditWriter,
  type AuditWriter,
} from "#/lib/audit/audit.server";
import { forgetAiSubscription } from "#/lib/billing/metering";
import {
  assertBillingScope,
  createBillingPlugin,
  getStripeClient,
  isStripeAutomaticTaxEnabled,
} from "#/lib/billing/stripe";
import {
  codeEmail,
  deleteAccountEmail,
  invitationEmail,
  sendEmail,
  type DeliverEmail,
  type EmailMessage,
} from "#/lib/email";
import { lazy } from "#/lib/lazy";
import {
  deletionNotice,
  teamAccessNotice,
  invalidateOrganizationAccess,
  type LiveProjects,
} from "#/lib/projects/live";

import { AUTH_EMAIL_CAPTCHA_ACTION } from "./captcha";
import {
  assertAccountDeletable,
  assertOrganizationPolicy,
  maxTeamsPerOrganization,
  memberOrganizations,
  organizationRoles,
  syncSeats,
} from "./organization-policy";
import { enforceTwoFactorOnSignIn } from "./two-factor";

// Loaded on first use because only Workers provide the binding module.
async function deliver(message: EmailMessage) {
  const { env } = await import("cloudflare:workers");
  await sendEmail(env, message);
}

export function createTwoFactorPlugin() {
  return twoFactor({
    issuer: "Texfolia",
    allowPasswordless: true,
  });
}

export function createPasskeyPlugin(baseURL: string) {
  const url = new URL(baseURL);
  return passkey({
    rpID: url.hostname,
    rpName: "Texfolia",
    origin: url.origin,
  });
}

export function createEmailOTPPlugin(sendOTPEmail: DeliverEmail) {
  return emailOTP({
    expiresIn: 300,
    storeOTP: "hashed",
    changeEmail: { enabled: true },
    async sendVerificationOTP({ email, otp, type }) {
      await sendOTPEmail(codeEmail({ to: email, code: otp, type }));
    },
  });
}

export function createOrganizationPlugin({
  baseURL,
  sendInvitationEmail,
  deleting,
  teams,
  audit,
}: {
  baseURL: string;
  sendInvitationEmail: DeliverEmail;
  deleting?: ReturnType<typeof deletionNotice>;
  teams?: ReturnType<typeof teamAccessNotice>;
  audit?: AuditWriter;
}) {
  return organization({
    roles: organizationRoles,
    // Teams group members so a project can be shared with all of them at once.
    teams: {
      enabled: true,
      defaultTeam: { enabled: false },
      allowRemovingAllTeams: true,
      maximumTeams: maxTeamsPerOrganization,
    },
    organizationHooks: {
      async afterUpdateOrganization({ organization, user }) {
        if (!organization) return;
        await audit?.({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "organization.updated",
          targetType: "organization",
          targetId: organization.id,
          metadata: {
            name: organization.name,
            slug: organization.slug,
          },
        });
      },
      async afterCreateInvitation({ invitation, inviter, organization }) {
        await audit?.({
          organizationId: organization.id,
          actorUserId: inviter.id,
          action: "invitation.created",
          targetType: "invitation",
          targetId: invitation.id,
          metadata: {
            email: invitation.email,
            role: invitation.role,
          },
        });
      },
      async afterAcceptInvitation({ invitation, member, user, organization }) {
        await audit?.({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "invitation.accepted",
          targetType: "invitation",
          targetId: invitation.id,
          metadata: {
            email: invitation.email,
            role: member.role,
            memberId: member.id,
          },
        });
      },
      async afterRejectInvitation({ invitation, user, organization }) {
        await audit?.({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "invitation.rejected",
          targetType: "invitation",
          targetId: invitation.id,
          metadata: {
            email: invitation.email,
            role: invitation.role,
          },
        });
      },
      async afterCancelInvitation({ invitation, cancelledBy, organization }) {
        await audit?.({
          organizationId: organization.id,
          actorUserId: cancelledBy.id,
          action: "invitation.canceled",
          targetType: "invitation",
          targetId: invitation.id,
          metadata: {
            email: invitation.email,
            role: invitation.role,
          },
        });
      },
      async afterAddMember({ member, user, organization }) {
        await audit?.({
          organizationId: organization.id,
          actorUserId: null,
          action: "member.added",
          targetType: "member",
          targetId: member.id,
          metadata: {
            targetUserId: member.userId,
            targetEmail: user.email,
            role: member.role,
          },
        });
      },
      async afterCreateTeam({ team, user, organization }) {
        await audit?.({
          organizationId: organization.id,
          actorUserId: user?.id ?? null,
          action: "team.created",
          targetType: "team",
          targetId: team.id,
          metadata: {
            teamName: team.name,
          },
        });
      },
      async afterUpdateTeam({ team, user, organization }) {
        if (!team) return;
        await audit?.({
          organizationId: organization.id,
          actorUserId: user.id,
          action: "team.updated",
          targetType: "team",
          targetId: team.id,
          metadata: {
            teamName: team.name,
          },
        });
      },
      // Teams can be granted project access, so changes reach live channels.
      async afterAddTeamMember({ team, teamMember }) {
        await teams?.after(team.id, [teamMember.userId]);
      },
      async afterRemoveTeamMember({ team, teamMember }) {
        await teams?.after(team.id, [teamMember.userId]);
      },
      async beforeDeleteTeam({ team }) {
        await teams?.before(team.id);
      },
      async afterDeleteTeam({ team, user, organization }) {
        await teams?.after(team.id);
        await audit?.({
          organizationId: organization.id,
          actorUserId: user?.id ?? null,
          action: "team.deleted",
          targetType: "team",
          targetId: team.id,
          metadata: {
            teamName: team.name,
          },
        });
      },
      async beforeDeleteOrganization({ organization }) {
        await deleting?.before({ organizationId: organization.id });
      },
      async afterDeleteOrganization() {
        await deleting?.after();
      },
    },
    requireEmailVerificationOnInvitation: true,
    async sendInvitationEmail({ id, email, organization }) {
      const invitationURL = new URL(
        `/accept-invitation/${encodeURIComponent(id)}`,
        baseURL,
      );

      await sendInvitationEmail(
        invitationEmail({
          to: email,
          organization: organization.name,
          url: invitationURL,
        }),
      );
    },
  });
}

/**
 * Sessions are cached in a signed cookie, so most requests do not read them from
 * the database. A session that was revoked, or whose user was deleted, keeps
 * working for up to this long where only the cookie is checked. Project access
 * is still read from the database every time, and so is the session for changes
 * to an account, organization or subscription and for live connections.
 */
export const sessionOptions = {
  cookieCache: { enabled: true, maxAge: 5 * 60 },
};

// Better Auth reads the database itself before changing an account.
const authoritativePaths = [
  "/organization/",
  "/subscription/",
  "/two-factor/",
  "/passkey/",
  "/revoke-session",
  "/revoke-other-sessions",
  "/revoke-sessions",
];

const previousMemberRole = new WeakMap<object, string>();
const updateRoleBodySchema = z.object({ memberId: z.string() });

export const beforeAuth = createAuthMiddleware(async (ctx) => {
  assertBillingScope(ctx);
  await assertOrganizationPolicy(ctx);
  await assertAccountDeletable(ctx);
  if (
    ctx.path === "/organization/update-member-role" &&
    ctx.body &&
    typeof ctx.body === "object"
  ) {
    const parsed = updateRoleBodySchema.safeParse(ctx.body);
    if (parsed.success) {
      const existing = await ctx.context.adapter.findOne<{ role: string }>({
        model: "member",
        where: [{ field: "id", value: parsed.data.memberId }],
      });
      if (existing) previousMemberRole.set(ctx.body, existing.role);
    }
  }
  const cookie = ctx.headers?.get("cookie");
  if (
    !cookie ||
    !authoritativePaths.some((prefix) => ctx.path.startsWith(prefix))
  )
    return;
  // Without the cached session, the endpoint reads it from the database. A cached
  // user can also lack the Stripe customer that another request just created.
  const cached = ctx.context.authCookies.sessionData.name;
  return {
    context: {
      headers: new Headers({
        cookie: cookie
          .split(";")
          .map((pair) => pair.trim())
          .filter(
            (pair) =>
              // Large sessions are split into `name.0`, `name.1` and so on.
              !pair.startsWith(`${cached}=`) && !pair.startsWith(`${cached}.`),
          )
          .join("; "),
      }),
    },
  };
});

const memberSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  role: z.string().optional(),
});
// Both endpoints return the removed member; failures return an APIError.
const memberResponseSchema = z.union([
  z.object({ member: memberSchema }).transform(({ member }) => member),
  memberSchema,
]);
const teamMemberSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  userId: z.string(),
});
const teamMemberBodySchema = z.object({
  teamId: z.string(),
  userId: z.coerce.string(),
  organizationId: z.string().optional(),
});

async function recordAfterOrganizationAudit(
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
  audit: AuditWriter | undefined,
) {
  if (!audit) return;
  if (ctx.context.returned instanceof Error) return;

  if (ctx.path === "/organization/update-member-role") {
    const updated = memberResponseSchema.safeParse(ctx.context.returned);
    if (!updated.success) return;
    const session =
      ctx.context.session ??
      (await getSessionFromCtx(ctx, { disableCookieCache: true }));
    const targetUser = await ctx.context.internalAdapter.findUserById(
      updated.data.userId,
    );
    const previousRole =
      ctx.body && typeof ctx.body === "object"
        ? previousMemberRole.get(ctx.body)
        : undefined;
    await audit({
      organizationId: updated.data.organizationId,
      actorUserId: session?.user.id ?? null,
      action: "member.role_updated",
      targetType: "member",
      targetId: updated.data.id,
      metadata: {
        targetUserId: updated.data.userId,
        targetEmail: targetUser?.email ?? null,
        previousRole: previousRole ?? null,
        role: updated.data.role ?? null,
      },
    });
    return;
  }

  if (
    ctx.path === "/organization/remove-member" ||
    ctx.path === "/organization/leave"
  ) {
    const removed = memberResponseSchema.safeParse(ctx.context.returned);
    if (!removed.success) return;
    const leaving = ctx.path === "/organization/leave";
    const session = leaving
      ? null
      : (ctx.context.session ??
        (await getSessionFromCtx(ctx, { disableCookieCache: true })));
    const targetUser = await ctx.context.internalAdapter.findUserById(
      removed.data.userId,
    );
    await audit({
      organizationId: removed.data.organizationId,
      actorUserId: leaving ? removed.data.userId : (session?.user.id ?? null),
      action: leaving ? "member.left" : "member.removed",
      targetType: "member",
      targetId: removed.data.id,
      metadata: {
        targetUserId: removed.data.userId,
        targetEmail: targetUser?.email ?? null,
        role: removed.data.role ?? null,
      },
    });
    return;
  }

  if (ctx.path === "/organization/add-team-member") {
    const added = teamMemberSchema.safeParse(ctx.context.returned);
    if (!added.success) return;
    const session =
      ctx.context.session ??
      (await getSessionFromCtx(ctx, { disableCookieCache: true }));
    const body = teamMemberBodySchema.safeParse(ctx.body);
    const teamRecord = await ctx.context.adapter.findOne<{
      id: string;
      name: string;
      organizationId: string;
    }>({
      model: "team",
      where: [{ field: "id", value: added.data.teamId }],
    });
    const organizationId =
      teamRecord?.organizationId ??
      (body.success ? body.data.organizationId : undefined) ??
      session?.session.activeOrganizationId;
    if (!organizationId) return;
    const targetUser = await ctx.context.internalAdapter.findUserById(
      added.data.userId,
    );
    await audit({
      organizationId,
      actorUserId: session?.user.id ?? null,
      action: "team.member_added",
      targetType: "team",
      targetId: added.data.teamId,
      metadata: {
        teamName: teamRecord?.name ?? null,
        targetUserId: added.data.userId,
        targetEmail: targetUser?.email ?? null,
      },
    });
    return;
  }

  if (ctx.path === "/organization/remove-team-member") {
    const returned = ctx.context.returned;
    if (!returned || typeof returned !== "object" || !("message" in returned))
      return;
    const body = teamMemberBodySchema.safeParse(ctx.body);
    if (!body.success) return;
    const session =
      ctx.context.session ??
      (await getSessionFromCtx(ctx, { disableCookieCache: true }));
    const teamRecord = await ctx.context.adapter.findOne<{
      id: string;
      name: string;
      organizationId: string;
    }>({
      model: "team",
      where: [{ field: "id", value: body.data.teamId }],
    });
    const organizationId =
      teamRecord?.organizationId ??
      body.data.organizationId ??
      session?.session.activeOrganizationId;
    if (!organizationId) return;
    const targetUser = await ctx.context.internalAdapter.findUserById(
      body.data.userId,
    );
    await audit({
      organizationId,
      actorUserId: session?.user.id ?? null,
      action: "team.member_removed",
      targetType: "team",
      targetId: body.data.teamId,
      metadata: {
        teamName: teamRecord?.name ?? null,
        targetUserId: body.data.userId,
        targetEmail: targetUser?.email ?? null,
      },
    });
  }
}

export function createAfterAuth({
  db,
  live,
  audit,
}: {
  db: Db;
  live: LiveProjects | undefined;
  audit?: AuditWriter;
}) {
  return createAuthMiddleware(async (ctx) => {
    const twoFactorResponse = await enforceTwoFactorOnSignIn(ctx);
    if (twoFactorResponse) return twoFactorResponse;
    // Browsers keep build files, which the next user must not find.
    if (ctx.path === "/sign-out" || ctx.path === "/delete-user")
      ctx.setHeader("Clear-Site-Data", '"cache"');
    await recordAfterOrganizationAudit(ctx, audit);
    const leaving = ctx.path === "/organization/leave";
    if (!leaving && ctx.path !== "/organization/remove-member") return;
    const removed = memberResponseSchema.safeParse(ctx.context.returned);
    if (!removed.success) return;
    await invalidateOrganizationAccess({ db, live, ...removed.data });
    if (leaving)
      await syncSeats(ctx, { id: removed.data.userId }, [
        removed.data.organizationId,
      ]);
  });
}

// Reads its secrets from process.env. BETTER_AUTH_URL is the app origin
// (https://app.texfolia.com in production), where OAuth callbacks land.
export function createAuth(db: Db, live?: LiveProjects) {
  const baseURL = process.env.BETTER_AUTH_URL!;
  const allowedHostnames = z
    .array(z.hostname())
    .nonempty()
    .parse(
      (process.env.TURNSTILE_HOSTNAMES ?? new URL(baseURL).hostname)
        .split(",")
        .map((hostname) => hostname.trim().toLowerCase())
        .filter(Boolean),
    );
  // Most requests never reach Stripe.
  const stripeKey = process.env.STRIPE_SECRET_KEY!;
  const stripeClient = lazy(() => getStripeClient(stripeKey));

  const deleting = deletionNotice({ db, live });
  const audit = createDbAuditWriter(db);
  // The organizations of an account being deleted. An instance serves one request.
  let leaving: string[] = [];

  return betterAuth({
    appName: "Texfolia",
    baseURL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    session: sessionOptions,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    disabledPaths: [
      "/request-password-reset",
      "/send-verification-email",
      "/get-access-token",
      "/refresh-token",
      "/two-factor/send-otp",
      "/two-factor/verify-otp",
    ],
    // Counters live in Postgres: each Worker isolate has its own memory, so
    // in-memory limits would reset per isolate.
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        // Session reads are frequent and neither send email nor check secrets.
        "/get-session": false,
        // Verified by signature, and all Stripe deliveries share a few IPs.
        "/stripe/webhook": false,
        // Public passkey auth routes: no email/signup, but bound challenge/verify floods.
        "/passkey/generate-authenticate-options": { window: 60, max: 10 },
        "/passkey/verify-authentication": { window: 60, max: 10 },
      },
    },
    hooks: {
      before: beforeAuth,
      after: createAfterAuth({ db, live, audit }),
    },
    account: {
      encryptOAuthTokens: true,
      // Everyone can sign in with an emailed code, so no account is the last way in.
      accountLinking: { enabled: true, allowUnlinkingAll: true },
    },
    databaseHooks: {
      user: {
        delete: {
          async before(user, ctx) {
            if (ctx) leaving = await memberOrganizations(ctx, user.id);
          },
          async after(user, ctx) {
            if (ctx) await syncSeats(ctx, user, leaving);
          },
        },
      },
    },
    user: {
      deleteUser: {
        enabled: true,
        async sendDeleteAccountVerification({ user, url }) {
          await deliver(deleteAccountEmail({ to: user.email, url }));
        },
        async beforeDelete(user) {
          await deleting.before({ userId: user.id });
        },
        async afterDelete() {
          await deleting.after();
        },
      },
    },
    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
      gitlab: {
        clientId: process.env.GITLAB_CLIENT_ID!,
        clientSecret: process.env.GITLAB_CLIENT_SECRET!,
      },
      microsoft: {
        clientId: process.env.MICROSOFT_CLIENT_ID!,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
      },
    },
    plugins: [
      createOrganizationPlugin({
        baseURL,
        sendInvitationEmail: deliver,
        deleting,
        teams: teamAccessNotice({ db, live }),
        audit,
      }),
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: process.env.TURNSTILE_SECRET!,
        allowedHostnames,
        expectedAction: AUTH_EMAIL_CAPTCHA_ACTION,
        endpoints: [
          "/sign-in/email",
          "/email-otp/send-verification-otp",
          "/email-otp/request-email-change",
          "/email-otp/request-password-reset",
          "/forget-password/email-otp",
        ],
      }),
      createEmailOTPPlugin(deliver),
      createTwoFactorPlugin(),
      createPasskeyPlugin(baseURL),
      createBillingPlugin({
        stripeClient,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
        proPriceId: process.env.STRIPE_PRO_PRICE_ID!,
        teamPriceId: process.env.STRIPE_TEAM_PRICE_ID!,
        automaticTax: isStripeAutomaticTaxEnabled(),
        onSubscriptionChange: (id) => forgetAiSubscription(db, id),
        onAuditEvent: audit,
        resolveOrganizationByCustomerId: async (stripeCustomerId) => {
          const found = await db.query.organization.findFirst({
            where: { stripeCustomerId },
            columns: { id: true },
          });
          return found?.id ?? null;
        },
      }),
      tanstackStartCookies(),
    ],
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: {
        joins: true,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
