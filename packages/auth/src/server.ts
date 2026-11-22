import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { stripe, type SubscriptionOptions } from "@better-auth/stripe";
import { type Db } from "@texfolia/db";
import * as schema from "@texfolia/db/schema";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { captcha, emailOTP, organization } from "better-auth/plugins";
import type { Member } from "better-auth/plugins/organization";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import Stripe from "stripe";
import { z } from "zod";

import { subscriptionPlans } from "./billing";
import { AUTH_EMAIL_CAPTCHA_ACTION } from "./client";
import { parseOrigins } from "./hosts";
import { isOrgAdmin } from "./roles";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};
export type SendEmail = (message: EmailMessage) => Promise<void>;

export const enforceBillingScope = createAuthMiddleware(async (ctx) => {
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
});

export function createEmailOTPPlugin(sendOTPEmail: SendEmail) {
  return emailOTP({
    expiresIn: 300,
    changeEmail: { enabled: true },
    async sendVerificationOTP({ email, otp, type }) {
      const purpose = {
        "sign-in": "sign-in",
        "email-verification": "email verification",
        "forget-password": "password reset",
        "change-email": "email change",
      }[type];
      await sendOTPEmail({
        to: email,
        subject: `Your Texfolia ${purpose} code`,
        text: `Your Texfolia ${purpose} code is ${otp}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
        html: `<p>Your Texfolia ${purpose} code is:</p><p><strong>${otp}</strong></p><p>It expires in 5 minutes. If you did not request this code, you can ignore this email.</p>`,
      });
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

      await sendInvitationEmail({
        to: email,
        subject: `You're invited to join ${organization.name} on Texfolia`,
        text: `You've been invited to join ${organization.name} on Texfolia. Sign in with this email address to review the invitation: ${invitationURL.href}`,
        html: `<p>You've been invited to join an organization on Texfolia.</p><p>Sign in with this email address to <a href="${invitationURL.href}">review the invitation</a>.</p>`,
      });
    },
  });
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
}: {
  stripeClient: Stripe;
  webhookSecret: string;
  proPriceId: string;
  teamPriceId: string;
  createCustomerOnSignUp?: boolean;
}) {
  return stripe({
    stripeClient,
    stripeWebhookSecret: webhookSecret,
    createCustomerOnSignUp,
    organization: { enabled: true },
    subscription: {
      enabled: true,
      authorizeReference: authorizeOrganizationBilling,
      plans: subscriptionPlans({ proPriceId, teamPriceId }),
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
// AUTH_TRUSTED_ORIGINS lists the marketing origins that may call auth, and
// AUTH_COOKIE_DOMAIN shares the session cookie across subdomains.
export function createAuth(
  db: Db,
  {
    sendEmail,
    onMemberRemoved,
  }: {
    sendEmail: SendEmail;
    onMemberRemoved?: (member: {
      organizationId: string;
      userId: string;
    }) => Promise<void>;
  },
) {
  const baseURL = process.env.BETTER_AUTH_URL!;
  const trustedOrigins = parseOrigins(process.env.AUTH_TRUSTED_ORIGINS);
  const cookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;
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
    trustedOrigins,
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
        if (removed.success) await onMemberRemoved?.(removed.data);
      }),
    },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true } },
    user: {
      deleteUser: {
        enabled: true,
        async sendDeleteAccountVerification({ user, url }) {
          await sendEmail({
            to: user.email,
            subject: "Confirm deletion of your Texfolia account",
            text: `Confirm account deletion: ${url}. This permanently deletes your account and personal projects. If you did not request this, ignore this email.`,
            html: `<p>Confirm deletion of your Texfolia account and personal projects:</p><p><a href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Delete my account</a></p><p>If you did not request this, ignore this email.</p>`,
          });
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
        sendInvitationEmail: sendEmail,
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
      createEmailOTPPlugin(sendEmail),
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
      ...(cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
        : {}),
      database: {
        joins: true,
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
