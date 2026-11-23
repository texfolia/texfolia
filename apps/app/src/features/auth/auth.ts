import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { type Db } from "@texfolia/db";
import * as schema from "@texfolia/db/schema";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { captcha, emailOTP, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import Stripe from "stripe";
import { z } from "zod";

import {
  createBillingPlugin,
  enforceBillingScope,
} from "#/features/billing/stripe";
import {
  invalidateOrganizationCollaborationAccess,
  type CollaborationAccess,
} from "#/features/collaboration/server";
import {
  codeEmail,
  deleteAccountEmail,
  invitationEmail,
  sendEmail,
  type EmailMessage,
  type SendEmail,
} from "#/features/email";

import { AUTH_EMAIL_CAPTCHA_ACTION } from "./captcha";

// Loaded on first use because only Workers provide the binding module.
async function deliver(message: EmailMessage) {
  const { env } = await import("cloudflare:workers");
  await sendEmail(env.EMAIL, message);
}

export function createEmailOTPPlugin(sendOTPEmail: SendEmail) {
  return emailOTP({
    expiresIn: 300,
    changeEmail: { enabled: true },
    async sendVerificationOTP({ email, otp, type }) {
      await sendOTPEmail(codeEmail({ to: email, code: otp, type }));
    },
  });
}

export function createOrganizationPlugin({
  baseURL,
  sendInvitationEmail,
}: {
  baseURL: string;
  sendInvitationEmail: SendEmail;
}) {
  return organization({
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
export function createAuth(db: Db, collaboration?: CollaborationAccess) {
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
    rateLimit: { enabled: true },
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
          await invalidateOrganizationCollaborationAccess({
            db,
            collaboration,
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
      }),
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: process.env.TURNSTILE_SECRET!,
        allowedHostnames,
        expectedAction: AUTH_EMAIL_CAPTCHA_ACTION,
        endpoints: [
          "/email-otp/send-verification-otp",
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
