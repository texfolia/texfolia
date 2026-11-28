import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { type Db } from "@texfolia/db";
import * as schema from "@texfolia/db/schema";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { captcha, emailOTP, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { z } from "zod";

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

// Loaded on first use because only Workers provide the binding module.
async function deliver(message: EmailMessage) {
  const { env } = await import("cloudflare:workers");
  await sendEmail(env, message);
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
}: {
  baseURL: string;
  sendInvitationEmail: DeliverEmail;
  deleting?: ReturnType<typeof deletionNotice>;
  teams?: ReturnType<typeof teamAccessNotice>;
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
      async afterDeleteTeam({ team }) {
        await teams?.after(team.id);
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
const authoritativePaths = ["/organization/", "/subscription/"];

export const beforeAuth = createAuthMiddleware(async (ctx) => {
  assertBillingScope(ctx);
  await assertOrganizationPolicy(ctx);
  await assertAccountDeletable(ctx);
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

const removedMemberSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
});
// Both endpoints return the removed member; failures return an APIError.
const removedMemberResponseSchema = z.union([
  z.object({ member: removedMemberSchema }).transform(({ member }) => member),
  removedMemberSchema,
]);

export function createAfterAuth({
  db,
  live,
}: {
  db: Db;
  live: LiveProjects | undefined;
}) {
  return createAuthMiddleware(async (ctx) => {
    // Browsers keep build files, which the next user must not find.
    if (ctx.path === "/sign-out" || ctx.path === "/delete-user")
      ctx.setHeader("Clear-Site-Data", '"cache"');
    const leaving = ctx.path === "/organization/leave";
    if (!leaving && ctx.path !== "/organization/remove-member") return;
    const removed = removedMemberResponseSchema.safeParse(ctx.context.returned);
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
  // The organizations of an account being deleted. An instance serves one request.
  let leaving: string[] = [];

  return betterAuth({
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
      },
    },
    hooks: {
      before: beforeAuth,
      after: createAfterAuth({ db, live }),
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
      createBillingPlugin({
        stripeClient,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
        proPriceId: process.env.STRIPE_PRO_PRICE_ID!,
        teamPriceId: process.env.STRIPE_TEAM_PRICE_ID!,
        automaticTax: isStripeAutomaticTaxEnabled(),
        onSubscriptionChange: (id) => forgetAiSubscription(db, id),
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
