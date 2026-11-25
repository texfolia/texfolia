import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { type Db } from "@texfolia/db";
import * as schema from "@texfolia/db/schema";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { captcha, emailOTP, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import Stripe from "stripe";
import { z } from "zod";

import { forgetAiSubscription } from "#/lib/billing/metering";
import { createBillingPlugin, enforceBillingScope } from "#/lib/billing/stripe";
import {
  codeEmail,
  deleteAccountEmail,
  invitationEmail,
  sendEmail,
  type DeliverEmail,
  type EmailMessage,
} from "#/lib/email";
import {
  deletionNotice,
  invalidateOrganizationAccess,
  type LiveProjects,
} from "#/lib/projects/live";

import { AUTH_EMAIL_CAPTCHA_ACTION } from "./captcha";

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
}: {
  baseURL: string;
  sendInvitationEmail: DeliverEmail;
  deleting?: ReturnType<typeof deletionNotice>;
}) {
  return organization({
    organizationHooks: {
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

const removedMemberSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
});
// Both endpoints return the removed member; failures return an APIError.
const removedMemberResponseSchema = z.union([
  z.object({ member: removedMemberSchema }).transform(({ member }) => member),
  removedMemberSchema,
]);

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
  const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2026-10-28.endive",
  });

  const deleting = deletionNotice({ db, live });

  return betterAuth({
    baseURL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
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
      before: enforceBillingScope,
      after: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path !== "/organization/remove-member" &&
          ctx.path !== "/organization/leave"
        )
          return;
        const removed = removedMemberResponseSchema.safeParse(
          ctx.context.returned,
        );
        if (removed.success)
          await invalidateOrganizationAccess({
            db,
            live,
            ...removed.data,
          });
      }),
    },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true } },
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
