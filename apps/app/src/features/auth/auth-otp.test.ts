import { expect, test } from "bun:test";
import assert from "node:assert/strict";

import type { EmailMessage, SendEmail } from "@texfolia/email";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { createEmailOTPPlugin } from "./auth";

function createTestAuth(deliver?: SendEmail) {
  const emails: EmailMessage[] = [];
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "otp-integration-test-secret-at-least-32-characters",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      createEmailOTPPlugin(
        deliver ??
          (async (email) => {
            emails.push(email);
          }),
      ),
    ],
  });
  return { auth, emails };
}

function deliveredCode(emails: EmailMessage[], purpose: string) {
  expect(emails).toHaveLength(1);
  const email = emails[0];
  assert(email);
  expect(email.to).toBe("person@example.com");
  expect(email.subject).toContain(purpose);
  const otp = /code is (\d{6})\./.exec(email.text)?.[1];
  assert(otp);
  expect(email.html).toContain(`<strong>${otp}</strong>`);
  expect(email.text).toContain("expires in 5 minutes");
  expect(email.html).toContain("expires in 5 minutes");
  return otp;
}

test("the emailed sign-in code creates a verified session and can only be used once", async () => {
  const { auth, emails } = createTestAuth();
  await auth.api.sendVerificationOTP({
    body: { email: "person@example.com", type: "sign-in" },
  });
  const otp = deliveredCode(emails, "sign-in");
  const result = await auth.api.signInEmailOTP({
    body: { email: "person@example.com", otp },
  });
  expect(result.user.emailVerified).toBe(true);
  expect(result.token).toBeTruthy();
  await expect(
    auth.api.signInEmailOTP({ body: { email: "person@example.com", otp } }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

test("the emailed verification code verifies an existing account", async () => {
  const { auth, emails } = createTestAuth();
  await auth.api.signUpEmail({
    body: {
      email: "person@example.com",
      name: "Person",
      password: "original-password-123",
    },
  });
  await auth.api.sendVerificationOTP({
    body: { email: "person@example.com", type: "email-verification" },
  });
  const otp = deliveredCode(emails, "email verification");
  await expect(
    auth.api.verifyEmailOTP({
      body: { email: "person@example.com", otp: "invalid" },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  const result = await auth.api.verifyEmailOTP({
    body: { email: "person@example.com", otp },
  });
  expect(result.user.emailVerified).toBe(true);
});

test("the emailed reset code changes the password and can only be used once", async () => {
  const { auth, emails } = createTestAuth();
  await auth.api.signUpEmail({
    body: {
      email: "person@example.com",
      name: "Person",
      password: "original-password-123",
    },
  });
  await auth.api.requestPasswordResetEmailOTP({
    body: { email: "person@example.com" },
  });
  const otp = deliveredCode(emails, "password reset");
  await auth.api.resetPasswordEmailOTP({
    body: { email: "person@example.com", otp, password: "new-password-456" },
  });
  const result = await auth.api.signInEmail({
    body: { email: "person@example.com", password: "new-password-456" },
  });
  expect(result.user.email).toBe("person@example.com");
  await expect(
    auth.api.signInEmail({
      body: { email: "person@example.com", password: "original-password-123" },
    }),
  ).rejects.toMatchObject({ statusCode: 401 });
  await expect(
    auth.api.resetPasswordEmailOTP({
      body: {
        email: "person@example.com",
        otp,
        password: "another-password-789",
      },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});

test("OTP delivery failures reach Better Auth for reporting", async () => {
  const plugin = createEmailOTPPlugin(async () => {
    throw new Error("Email provider unavailable");
  });
  for (const type of [
    "sign-in",
    "email-verification",
    "forget-password",
    "change-email",
  ] as const) {
    await expect(
      plugin.options.sendVerificationOTP({
        email: "person@example.com",
        otp: "123456",
        type,
      }),
    ).rejects.toThrow("Email provider unavailable");
  }
});

test("emailed codes expire after the advertised five minutes", async () => {
  const { auth, emails } = createTestAuth();
  const startedAt = Date.now();
  await auth.api.sendVerificationOTP({
    body: { email: "person@example.com", type: "sign-in" },
  });
  const otp = deliveredCode(emails, "sign-in");
  const context = await auth.$context;
  const identifier = "sign-in-otp-person@example.com";
  const verification =
    await context.internalAdapter.findVerificationValue(identifier);
  assert(verification);
  expect(verification.expiresAt.getTime()).toBeGreaterThanOrEqual(
    startedAt + 300_000,
  );
  expect(verification.expiresAt.getTime()).toBeLessThanOrEqual(
    Date.now() + 300_000,
  );
  await context.adapter.update({
    model: "verification",
    where: [{ field: "id", value: verification.id }],
    update: { expiresAt: new Date(Date.now() - 1000) },
  });
  await expect(
    auth.api.signInEmailOTP({ body: { email: "person@example.com", otp } }),
  ).rejects.toMatchObject({ statusCode: 400 });
});
