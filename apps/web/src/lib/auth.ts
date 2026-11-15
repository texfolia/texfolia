import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { stripe, type SubscriptionOptions } from "@better-auth/stripe";
import { type Db } from "@texfolia/db";
import * as schema from "@texfolia/db/schema";
import { betterAuth } from "better-auth";
import { captcha, emailOTP, organization } from "better-auth/plugins";
import type { Member } from "better-auth/plugins/organization";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import Stripe from "stripe";
import { z } from "zod";

import { AUTH_EMAIL_CAPTCHA_ACTION } from "./auth-captcha";
import { canManageBilling, subscriptionPlans } from "./billing";
import { enforceBillingScope } from "./billing.server";

async function sendEmail(
  options: Parameters<typeof import("./email").sendEmail>[0],
) {
  const { sendEmail } = await import("./email");
  return sendEmail(options);
}

export function createEmailOTPPlugin(sendOTPEmail: typeof sendEmail) {
  return emailOTP({
    expiresIn: 300,
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
  sendInvitationEmail: typeof sendEmail;
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

  return membership ? canManageBilling(membership.role) : false;
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

export function createAuth(db: Db) {
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
    disabledPaths: ["/request-password-reset", "/send-verification-email"],
    rateLimit: { enabled: true },
    hooks: { before: enforceBillingScope },
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
      database: {
        joins: true,
      },
    },
  });
}
