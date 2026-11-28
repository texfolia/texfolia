import { afterEach, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";

import { createDb } from "@texfolia/db";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import type { EmailMessage } from "#/lib/email";

import { createAuth, createEmailOTPPlugin } from "./auth";

let clientId = 0;

function productionOptions(
  hostnames: string | null = "localhost, www.texfolia.com",
) {
  const env = {
    BETTER_AUTH_URL: "http://localhost:3000",
    STRIPE_SECRET_KEY: "sk_test_auth_abuse",
    TURNSTILE_SECRET: "turnstile-test-secret",
    TURNSTILE_HOSTNAMES: hostnames ?? "",
    GITHUB_CLIENT_ID: "test-github",
    GITHUB_CLIENT_SECRET: "test-github-secret",
    GOOGLE_CLIENT_ID: "test-google",
    GOOGLE_CLIENT_SECRET: "test-google-secret",
    GITLAB_CLIENT_ID: "test-gitlab",
    GITLAB_CLIENT_SECRET: "test-gitlab-secret",
    MICROSOFT_CLIENT_ID: "test-microsoft",
    MICROSOFT_CLIENT_SECRET: "test-microsoft-secret",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  if (hostnames === null)
    Reflect.deleteProperty(process.env, "TURNSTILE_HOSTNAMES");
  try {
    // Construct the production config without opening a Postgres connection.
    return createAuth(createDb("postgres://unused:unused@localhost/unused"))
      .options;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createTestAuth(hostnames?: string | null) {
  const options = productionOptions(hostnames);
  const emails: EmailMessage[] = [];
  const database = {
    user: [],
    session: [],
    account: [],
    verification: [],
    rateLimit: [],
    twoFactor: [],
    passkey: [],
  };
  const stripePlugin = options.plugins.find((plugin) => plugin.id === "stripe");
  assert(stripePlugin && "options" in stripePlugin);
  assert("stripeClient" in stripePlugin.options);
  const stripeClient = stripePlugin.options.stripeClient;
  const customerSearch = spyOn(
    stripeClient.customers,
    "search",
  ).mockImplementation(() => {
    throw new Error("Unexpected Stripe customer search");
  });
  const customerList = spyOn(stripeClient.customers, "list").mockImplementation(
    () => {
      throw new Error("Unexpected Stripe customer list");
    },
  );
  const customerCreate = spyOn(
    stripeClient.customers,
    "create",
  ).mockImplementation(async () => {
    throw new Error("Unexpected Stripe customer creation");
  });
  const auth = betterAuth({
    ...options,
    secret: "auth-abuse-integration-test-secret-at-least-32-characters",
    database: memoryAdapter(database),
    logger: { disabled: true },
    plugins: options.plugins.map((plugin) =>
      plugin.id === "email-otp"
        ? createEmailOTPPlugin(async (email) => {
            emails.push(email);
          })
        : plugin,
    ),
  });
  const ip = `192.0.2.${++clientId}`;
  const post = (
    path: string,
    body: object,
    token?: string,
    headers?: Record<string, string>,
  ) =>
    auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          "cf-connecting-ip": ip,
          "x-forwarded-for": ip,
          ...(token === undefined ? {} : { "x-captcha-response": token }),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  const seedUser = async () => {
    const context = await auth.$context;
    await context.internalAdapter.createUser(
      {
        email: "known@example.com",
        name: "Known user",
        emailVerified: true,
      },
      { method: "email-otp" },
    );
  };
  return {
    auth,
    emails,
    database,
    post,
    seedUser,
    customerSearch,
    customerList,
    customerCreate,
  };
}

const senders = [
  {
    path: "/email-otp/send-verification-otp",
    body: { type: "sign-in" },
  },
  {
    path: "/email-otp/send-verification-otp",
    body: { type: "email-verification" },
  },
  {
    path: "/email-otp/send-verification-otp",
    body: { type: "forget-password" },
  },
  { path: "/email-otp/request-password-reset", body: {} },
  { path: "/forget-password/email-otp", body: {} },
];

afterEach(() => {
  mock.restore();
});

function mockSiteverify(
  result: object = {
    success: true,
    hostname: "localhost",
    action: "auth-email",
  },
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toBe(
          "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        );
        return Response.json(result);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
}

for (const { path, body } of senders) {
  test(`${path} ${JSON.stringify(body)} requires CAPTCHA before sending`, async () => {
    const { post, emails, seedUser } = createTestAuth();
    await seedUser();
    const response = await post(path, { email: "known@example.com", ...body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "MISSING_RESPONSE" });
    expect(emails).toHaveLength(0);
  });
}

for (const { path, body } of senders) {
  test(`${path} ${JSON.stringify(body)} accepts valid tokens and keeps account responses generic`, async () => {
    const { post, emails, seedUser } = createTestAuth();
    await seedUser();
    const verify = mockSiteverify();
    for (const email of ["known@example.com", "unknown@example.com"]) {
      const response = await post(path, { email, ...body }, "valid-token");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
    }
    expect(verify).toHaveBeenCalledTimes(2);
    expect(emails).toHaveLength(
      "type" in body && body.type === "sign-in" ? 2 : 1,
    );
  });

  test(`${path} ${JSON.stringify(body)} rejects invalid tokens for known and unknown accounts`, async () => {
    const { post, emails, seedUser } = createTestAuth();
    await seedUser();
    const verify = mockSiteverify({
      success: false,
      "error-codes": ["invalid-input-response"],
    });
    for (const email of ["known@example.com", "unknown@example.com"]) {
      const response = await post(path, { email, ...body }, "invalid-token");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        message: "Captcha verification failed",
        code: "VERIFICATION_FAILED",
      });
    }
    expect(verify).toHaveBeenCalledTimes(2);
    expect(emails).toHaveLength(0);
  });

  test(`${path} ${JSON.stringify(body)} limits parallel sends before verifying more tokens`, async () => {
    const { post, emails, seedUser } = createTestAuth();
    await seedUser();
    const verify = mockSiteverify();
    const send = (i: number) =>
      post(path, { email: "known@example.com", ...body }, `valid-${i}`, {
        "x-forwarded-for": `198.51.100.${i + 1}`,
      });
    // The memory adapter has no unique keys, so the first send creates the
    // counter alone. test/postgres covers parallel first sends.
    const responses = [
      await send(0),
      ...(await Promise.all([1, 2, 3, 4].map(send))),
    ];
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(3);
    const limited = responses.filter((response) => response.status === 429);
    expect(limited).toHaveLength(2);
    for (const response of limited) {
      expect(Number(response.headers.get("x-retry-after"))).toBeGreaterThan(0);
      expect(await response.json()).toEqual({
        message: "Too many requests. Please try again later.",
      });
    }
    expect(verify).toHaveBeenCalledTimes(3);
    expect(emails).toHaveLength(3);
  });
}

for (const result of [
  { success: true, hostname: "attacker.example", action: "auth-email" },
  { success: true, action: "auth-email" },
  { success: true, hostname: "localhost", action: "other-action" },
  { success: true, hostname: "localhost" },
  { success: false, "error-codes": ["timeout-or-duplicate"] },
]) {
  test(`Turnstile fails closed for ${JSON.stringify(result)}`, async () => {
    const { post, emails, seedUser } = createTestAuth();
    await seedUser();
    mockSiteverify(result);
    for (const path of [
      "/email-otp/send-verification-otp",
      "/email-otp/request-password-reset",
      "/forget-password/email-otp",
    ]) {
      const response = await post(
        path,
        { email: "known@example.com", type: "sign-in" },
        "wrong-context",
      );
      expect(response.status).toBe(403);
    }
    expect(emails).toHaveLength(0);
  });
}

test("a second configured hostname is accepted", async () => {
  const { post, emails } = createTestAuth();
  mockSiteverify({
    success: true,
    hostname: "www.texfolia.com",
    action: "auth-email",
  });
  expect(
    (
      await post(
        "/email-otp/send-verification-otp",
        { email: "new@example.com", type: "sign-in" },
        "valid-token",
      )
    ).status,
  ).toBe(200);
  expect(emails).toHaveLength(1);
});

test("Siteverify outages fail closed", async () => {
  const { post, emails } = createTestAuth();
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response("Unavailable", { status: 503 }), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );
  expect(
    (
      await post(
        "/email-otp/send-verification-otp",
        { email: "new@example.com", type: "sign-in" },
        "token",
      )
    ).status,
  ).toBe(500);
  expect(emails).toHaveLength(0);
});

for (const token of [undefined, "valid-token"]) {
  test(`unused password signup cannot create users or Stripe customers with token ${token}`, async () => {
    const {
      post,
      database,
      emails,
      customerSearch,
      customerList,
      customerCreate,
    } = createTestAuth();
    mockSiteverify();
    const response = await post(
      "/sign-up/email",
      {
        email: "new@example.com",
        name: "New user",
        password: "a-long-password-123",
      },
      token,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    });
    expect(database.user).toHaveLength(0);
    expect(database.account).toHaveLength(0);
    expect(emails).toHaveLength(0);
    expect(customerSearch).not.toHaveBeenCalled();
    expect(customerList).not.toHaveBeenCalled();
    expect(customerCreate).not.toHaveBeenCalled();
  });
}

test("unused link email senders are unavailable", async () => {
  const { post, emails } = createTestAuth();
  for (const path of ["/request-password-reset", "/send-verification-email"]) {
    expect((await post(path, { email: "known@example.com" })).status).toBe(404);
  }
  expect(emails).toHaveLength(0);
});

test("OTP helpers cannot expose or mint codes over HTTP", async () => {
  const { post, emails } = createTestAuth();
  for (const path of [
    "/email-otp/create-verification-otp",
    "/email-otp/get-verification-otp",
  ]) {
    expect(
      (await post(path, { email: "known@example.com", type: "sign-in" }))
        .status,
    ).toBe(404);
  }
  expect(emails).toHaveLength(0);
});

test("password sign-in requires CAPTCHA", async () => {
  const { post, seedUser } = createTestAuth();
  await seedUser();
  const verify = mockSiteverify();
  const body = { email: "known@example.com", password: "a-long-password-123" };
  const missing = await post("/sign-in/email", body);
  expect(missing.status).toBe(400);
  expect(await missing.json()).toMatchObject({ code: "MISSING_RESPONSE" });
  expect(verify).not.toHaveBeenCalled();
  // A valid token reaches the password check.
  expect((await post("/sign-in/email", body, "valid-token")).status).toBe(401);
  expect(verify).toHaveBeenCalledTimes(1);
});

test("email change requires CAPTCHA before its session check", async () => {
  const { post, emails } = createTestAuth();
  const response = await post("/email-otp/request-email-change", {
    newEmail: "new@example.com",
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "MISSING_RESPONSE" });
  expect(emails).toHaveLength(0);
});

test("rate limits are counted in the database, except for session reads and Stripe webhooks", async () => {
  const { auth, post, database } = createTestAuth();
  await post("/sign-in/email-otp", { email: "known@example.com", otp: "1" });
  expect(database.rateLimit).toMatchObject([{ count: 1 }]);
  await auth.handler(
    new Request("http://localhost:3000/api/auth/get-session", {
      headers: { "cf-connecting-ip": "192.0.2.250" },
    }),
  );
  await post("/stripe/webhook", {});
  expect(database.rateLimit).toHaveLength(1);
});

test("email change and organization invitations require a session", async () => {
  const { post, emails } = createTestAuth();
  mockSiteverify();
  for (const path of [
    "/email-otp/request-email-change",
    "/organization/invite-member",
  ]) {
    const response = await post(
      path,
      { newEmail: "new@example.com", email: "new@example.com", role: "member" },
      "valid-token",
    );
    expect(response.status).toBe(401);
  }
  expect(emails).toHaveLength(0);
});

for (const path of [
  "/email-otp/request-password-reset/",
  "/email-otp//request-password-reset",
  "/forget-password/email-otp/",
  "/email-otp/%73end-verification-otp",
]) {
  test(`path normalization cannot bypass CAPTCHA: ${path}`, async () => {
    const { post, emails, seedUser } = createTestAuth();
    await seedUser();
    expect(
      (await post(path, { email: "known@example.com", type: "sign-in" })).ok,
    ).toBe(false);
    expect(emails).toHaveLength(0);
  });
}

test("empty or malformed hostname policy is rejected", () => {
  for (const hostnames of [
    "",
    " , ",
    "https://www.texfolia.com",
    "*.texfolia.com",
  ]) {
    expect(() => productionOptions(hostnames)).toThrow();
  }
});

test("OTP signup reaches Stripe only after email ownership is proven", async () => {
  const { post, database, emails, customerSearch } = createTestAuth();
  mockSiteverify();
  expect(
    (
      await post(
        "/email-otp/send-verification-otp",
        { email: "new@example.com", type: "sign-in" },
        "valid-token",
      )
    ).status,
  ).toBe(200);
  expect(database.user).toHaveLength(0);
  expect(customerSearch).not.toHaveBeenCalled();
  const otp = /code is (\d{6})\./.exec(emails[0]?.text ?? "")?.[1];
  assert(otp);
  expect(
    (
      await post("/sign-in/email-otp", {
        email: "new@example.com",
        otp: "invalid",
      })
    ).status,
  ).toBe(400);
  expect(database.user).toHaveLength(0);
  expect(customerSearch).not.toHaveBeenCalled();
  const response = await post("/sign-in/email-otp", {
    email: "new@example.com",
    otp,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    user: { emailVerified: true },
  });
  expect(database.user).toHaveLength(1);
  expect(customerSearch).toHaveBeenCalledTimes(1);
});

for (const path of [
  "/sign-in/email-otp",
  "/sign-in/email",
  "/email-otp/reset-password",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
]) {
  test(`credential and code attempts are rate limited: ${path}`, async () => {
    const { post, seedUser } = createTestAuth();
    await seedUser();
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post(path, {
        email: "known@example.com",
        otp: "invalid",
        password: "a-long-password-123",
        type: "sign-in",
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(429);
    }
    const limited = await post(path, {
      email: "known@example.com",
      otp: "invalid",
      password: "a-long-password-123",
      type: "sign-in",
    });
    expect(limited.status).toBe(429);
  });
}

for (const path of [
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
]) {
  test(`missing CAPTCHA attempts consume the rate limit: ${path}`, async () => {
    const { post, emails } = createTestAuth();
    const verify = mockSiteverify();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        (await post(path, { email: "unknown@example.com", type: "sign-in" }))
          .status,
      ).toBe(400);
    }
    expect(
      (await post(path, { email: "unknown@example.com", type: "sign-in" }))
        .status,
    ).toBe(429);
    expect(verify).not.toHaveBeenCalled();
    expect(emails).toHaveLength(0);
  });
}

test("an absent hostname list allows only the configured auth hostname", async () => {
  const { post, emails } = createTestAuth(null);
  const verify = mockSiteverify();
  expect(
    (
      await post(
        "/email-otp/send-verification-otp",
        { email: "new@example.com", type: "sign-in" },
        "valid-token",
      )
    ).status,
  ).toBe(200);
  verify.mockRestore();
  mockSiteverify({
    success: true,
    hostname: "www.texfolia.com",
    action: "auth-email",
  });
  expect(
    (
      await post(
        "/email-otp/send-verification-otp",
        { email: "new@example.com", type: "sign-in" },
        "other-host-token",
      )
    ).status,
  ).toBe(403);
  expect(emails).toHaveLength(1);
});

test("signing out clears the build files the browser kept", async () => {
  const { post } = createTestAuth();
  const response = await post("/sign-out", {});
  expect(response.headers.get("Clear-Site-Data")).toBe('"cache"');
  const other = await post("/sign-in/email", {});
  expect(other.headers.has("Clear-Site-Data")).toBe(false);
});

test("hostname configuration accepts whitespace and normalizes case", async () => {
  const { post, emails } = createTestAuth(" LOCALHOST, WWW.TEXFOLIA.COM ");
  mockSiteverify();
  expect(
    (
      await post(
        "/email-otp/send-verification-otp",
        { email: "new@example.com", type: "sign-in" },
        "valid-token",
      )
    ).status,
  ).toBe(200);
  expect(emails).toHaveLength(1);
});

test("unused 2FA email OTP endpoints are disabled", async () => {
  const { post } = createTestAuth();
  for (const path of ["/two-factor/send-otp", "/two-factor/verify-otp"]) {
    expect((await post(path, { code: "123456" })).status).toBe(404);
  }
});

for (const path of [
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]) {
  test(`2FA verification endpoints are rate limited: ${path}`, async () => {
    const { post } = createTestAuth();
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post(path, { code: "000000" });
      expect(response.status).toBe(401);
    }
    const limited = await post(path, { code: "000000" });
    expect(limited.status).toBe(429);
  });
}

test("public passkey authentication routes are rate limited", async () => {
  const { auth, post } = createTestAuth();
  const ip = `192.0.2.${++clientId}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await auth.handler(
      new Request(
        "http://localhost:3000/api/auth/passkey/generate-authenticate-options",
        {
          method: "GET",
          headers: {
            origin: "http://localhost:3000",
            "cf-connecting-ip": ip,
          },
        },
      ),
    );
    expect(response.status).toBe(200);
  }
  const limitedOptions = await auth.handler(
    new Request(
      "http://localhost:3000/api/auth/passkey/generate-authenticate-options",
      {
        method: "GET",
        headers: {
          origin: "http://localhost:3000",
          "cf-connecting-ip": ip,
        },
      },
    ),
  );
  expect(limitedOptions.status).toBe(429);

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await post("/passkey/verify-authentication", {
      response: {},
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(429);
  }
  const limitedVerify = await post("/passkey/verify-authentication", {
    response: {},
  });
  expect(limitedVerify.status).toBe(429);
});

test("2FA and passkey management endpoints require an authenticated session", async () => {
  const { auth, post } = createTestAuth();
  for (const path of [
    "/two-factor/enable",
    "/two-factor/disable",
    "/two-factor/generate-backup-codes",
    "/passkey/update-passkey",
    "/passkey/delete-passkey",
  ]) {
    const response = await post(path, { id: "pk-1", name: "Key" });
    expect(response.status).toBe(401);
  }
  for (const path of [
    "/passkey/generate-register-options",
    "/passkey/list-user-passkeys",
  ]) {
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "GET",
        headers: {
          origin: "http://localhost:3000",
          "cf-connecting-ip": `192.0.2.${++clientId}`,
        },
      }),
    );
    expect(response.status).toBe(401);
  }
});
