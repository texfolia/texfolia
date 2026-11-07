import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { stripe } from "@better-auth/stripe";
import { db } from "@texfolia/db";
import * as schema from "@texfolia/db";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import Stripe from "stripe";

import { sendEmail } from "#/lib/email";
import { verifyLoginTurnstile } from "#/lib/turnstile.server";

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-10-28.endive",
});

export const auth = betterAuth({
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/email-otp/send-verification-otp") return;

      if (!ctx.headers || !(await verifyLoginTurnstile(ctx.headers))) {
        throw new APIError("FORBIDDEN", {
          message: "Security verification failed. Please try again.",
        });
      }
    }),
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
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
    emailOTP({
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 3,
      storeOTP: "hashed",
      async sendVerificationOTP({ email, otp }) {
        try {
          await sendEmail({
            to: email,
            subject: "Your Texfolia verification code",
            text: `Your Texfolia verification code is ${otp}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
            html: `<p>Your Texfolia verification code is:</p><p><strong>${otp}</strong></p><p>It expires in 5 minutes. If you did not request this code, you can ignore this email.</p>`,
          });
        } catch {
          throw new APIError("SERVICE_UNAVAILABLE", {
            message:
              "Unable to send your verification code. Please try again later.",
          });
        }
      },
    }),
    stripe({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      createCustomerOnSignUp: true,
    }),
    tanstackStartCookies(),
  ],
  advanced: {
    database: {
      joins: true,
    },
  },
});
