import { afterEach, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";

import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import type { EmailMessage } from "#/lib/email";
import { loginSearch } from "#/routes/login/route";

import {
  beforeAuth,
  createAfterAuth,
  createEmailOTPPlugin,
  createPasskeyPlugin,
  createTwoFactorPlugin,
  sessionOptions,
} from "./auth";

afterEach(() => {
  mock.restore();
});

function createTestAuth() {
  const emails: EmailMessage[] = [];
  const database: {
    user: Record<string, unknown>[];
    session: Record<string, unknown>[];
    account: Record<string, unknown>[];
    verification: Record<string, unknown>[];
    rateLimit: Record<string, unknown>[];
    twoFactor: Record<string, unknown>[];
    passkey: Record<string, unknown>[];
  } = {
    user: [],
    session: [],
    account: [],
    verification: [],
    rateLimit: [],
    twoFactor: [],
    passkey: [],
  };
  const auth = betterAuth({
    appName: "Texfolia",
    baseURL: "http://localhost:3000",
    secret: "two-factor-passkey-test-secret-at-least-32-characters",
    database: memoryAdapter(database),
    session: sessionOptions,
    emailAndPassword: { enabled: true },
    hooks: {
      before: beforeAuth,
      after: createAfterAuth({ db: undefined as never, live: undefined }),
    },
    socialProviders: {
      github: {
        clientId: "test-github-id",
        clientSecret: "test-github-secret",
      },
    },
    plugins: [
      createEmailOTPPlugin(async (email) => {
        emails.push(email);
      }),
      createTwoFactorPlugin(),
      createPasskeyPlugin("http://localhost:3000"),
    ],
    logger: { disabled: true },
  });

  const cookieJar = new Map<string, string>();

  function mergeCookies(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";").map((part) => part.trim());
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = attrs.some((attr) =>
        attr.toLowerCase().startsWith("max-age=0"),
      );
      if (expired || value === "") cookieJar.delete(name);
      else cookieJar.set(name, value);
    }
  }

  function cookieHeader() {
    return Array.from(cookieJar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async function request(
    path: string,
    init: {
      method?: string;
      body?: object;
      headers?: Record<string, string>;
      useJar?: boolean;
    } = {},
  ) {
    const useJar = init.useJar ?? true;
    const headers: Record<string, string> = {
      origin: "http://localhost:3000",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(useJar && cookieJar.size > 0 ? { cookie: cookieHeader() } : {}),
      ...init.headers,
    };
    const response = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
    if (useJar) mergeCookies(response);
    return response;
  }

  async function signInWithEmailOtp(email: string) {
    emails.length = 0;
    const sent = await request("/email-otp/send-verification-otp", {
      body: { email, type: "sign-in" },
    });
    expect(sent.status).toBe(200);
    const otp = /code is (\d{6})\./.exec(emails[0]?.text ?? "")?.[1];
    assert(otp);
    return request("/sign-in/email-otp", { body: { email, otp } });
  }

  return {
    auth,
    database,
    emails,
    cookieJar,
    cookieHeader,
    request,
    signInWithEmailOtp,
  };
}

function totpCodeFromUri(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get("secret");
  assert(secret);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.toUpperCase().replaceAll("=", "");
  let bits = "";
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    assert(idx !== -1);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

test("passwordless user can enroll TOTP 2FA, view/regenerate backup codes, and disable without a password", async () => {
  const { auth, request, signInWithEmailOtp } = createTestAuth();

  const signIn = await signInWithEmailOtp("passwordless@example.com");
  expect(signIn.status).toBe(200);
  const { user } = (await signIn.json()) as { user: { id: string } };

  // Enable starts enrollment but keeps twoFactorEnabled = false until verified.
  const enable = await request("/two-factor/enable", {
    body: { method: "totp" },
  });
  expect(enable.status).toBe(200);
  const enabled = (await enable.json()) as {
    method: string;
    totpURI: string;
    backupCodes: string[];
  };
  expect(enabled.method).toBe("totp");
  expect(enabled.totpURI).toContain("issuer=Texfolia");
  expect(enabled.backupCodes).toHaveLength(10);

  const sessionBeforeVerify = (await (
    await request("/get-session")
  ).json()) as {
    user: { twoFactorEnabled: boolean };
  };
  expect(sessionBeforeVerify.user.twoFactorEnabled).toBe(false);

  // Verify TOTP completes enrollment.
  const code = totpCodeFromUri(enabled.totpURI);
  const verify = await request("/two-factor/verify-totp", {
    body: { code },
  });
  expect(verify.status).toBe(200);

  const sessionAfterVerify = (await (await request("/get-session")).json()) as {
    user: { twoFactorEnabled: boolean };
  };
  expect(sessionAfterVerify.user.twoFactorEnabled).toBe(true);

  // Server-only viewBackupCodes returns the 10 codes.
  const viewed = await auth.api.viewBackupCodes({ body: { userId: user.id } });
  expect(viewed.backupCodes).toEqual(enabled.backupCodes);

  // Regenerate backup codes works without a password for passwordless accounts.
  const regen = await request("/two-factor/generate-backup-codes", {
    body: {},
  });
  expect(regen.status).toBe(200);
  const regenBody = (await regen.json()) as { backupCodes: string[] };
  expect(regenBody.backupCodes).toHaveLength(10);
  expect(regenBody.backupCodes).not.toEqual(enabled.backupCodes);

  // Disable works without a password for passwordless accounts.
  const disable = await request("/two-factor/disable", { body: {} });
  expect(disable.status).toBe(200);
  const sessionAfterDisable = (await (
    await request("/get-session")
  ).json()) as {
    user: { twoFactorEnabled: boolean };
  };
  expect(sessionAfterDisable.user.twoFactorEnabled).toBe(false);
});

test("credential (password) user must supply their password to enable, regenerate backup codes, and disable 2FA", async () => {
  const { request } = createTestAuth();
  const password = "strong-credential-password-123";

  const signUp = await request("/sign-up/email", {
    body: {
      email: "cred@example.com",
      name: "Cred User",
      password,
    },
  });
  expect(signUp.status).toBe(200);

  // Missing or wrong password fails.
  expect(
    (await request("/two-factor/enable", { body: { method: "totp" } })).status,
  ).toBe(400);
  expect(
    (
      await request("/two-factor/enable", {
        body: { method: "totp", password: "wrong-password" },
      })
    ).status,
  ).toBe(400);

  // Correct password succeeds.
  const enable = await request("/two-factor/enable", {
    body: { method: "totp", password },
  });
  expect(enable.status).toBe(200);
  const { totpURI } = (await enable.json()) as { totpURI: string };
  expect(
    (
      await request("/two-factor/verify-totp", {
        body: { code: await totpCodeFromUri(totpURI) },
      })
    ).status,
  ).toBe(200);

  // Regenerate and disable require password too.
  expect(
    (await request("/two-factor/generate-backup-codes", { body: {} })).status,
  ).toBe(400);
  expect(
    (
      await request("/two-factor/generate-backup-codes", {
        body: { password },
      })
    ).status,
  ).toBe(200);

  expect((await request("/two-factor/disable", { body: {} })).status).toBe(400);
  expect(
    (await request("/two-factor/disable", { body: { password } })).status,
  ).toBe(200);
});

test("email OTP sign-in challenges for 2FA, leaves no usable session while pending, and supports trusted devices", async () => {
  const { database, cookieJar, request, signInWithEmailOtp } = createTestAuth();

  await signInWithEmailOtp("otp2fa@example.com");
  const enable = await request("/two-factor/enable", {
    body: { method: "totp" },
  });
  const { totpURI } = (await enable.json()) as { totpURI: string };
  await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });

  // Sign out and sign in again with email OTP.
  await request("/sign-out", { body: {} });
  cookieJar.clear();
  database.session.length = 0;

  const challenged = await signInWithEmailOtp("otp2fa@example.com");
  expect(challenged.status).toBe(200);
  expect(await challenged.json()).toEqual({
    twoFactorRedirect: true,
    twoFactorMethods: ["totp"],
  });

  // Pending 2FA must not leave a session in DB or a usable session cookie.
  expect(database.session).toHaveLength(0);
  expect(await (await request("/get-session")).json()).toBeNull();

  // Completing TOTP with trustDevice=true signs in and sets trust_device cookie.
  const verified = await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI), trustDevice: true },
  });
  expect(verified.status).toBe(200);
  expect(database.session).toHaveLength(1);
  const trustedCookie = cookieJar.get("better-auth.trust_device");
  expect(trustedCookie).toBeTruthy();

  // Sign out (preserving trust_device cookie) and sign in again via email OTP: skips 2FA!
  await request("/sign-out", { body: {} });
  const trustedSignIn = await signInWithEmailOtp("otp2fa@example.com");
  expect(trustedSignIn.status).toBe(200);
  const trustedBody = (await trustedSignIn.json()) as {
    token?: string;
    twoFactorRedirect?: boolean;
  };
  expect(trustedBody.twoFactorRedirect).toBeUndefined();
  expect(trustedBody.token).toBeTruthy();
  // Trust device token was rotated.
  expect(cookieJar.get("better-auth.trust_device")).not.toBe(trustedCookie);
});

test("OAuth callback challenges 2FA-enabled users by redirecting to /login?twoFactor=1 without a usable session", async () => {
  const { database, cookieJar, request, signInWithEmailOtp } = createTestAuth();

  await signInWithEmailOtp("oauth2fa@example.com");
  const enable = await request("/two-factor/enable", {
    body: { method: "totp" },
  });
  const { totpURI } = (await enable.json()) as { totpURI: string };
  await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });
  await request("/sign-out", { body: {} });
  cookieJar.clear();
  database.session.length = 0;

  // Start GitHub OAuth flow to get a valid state + cookie.
  const start = await request("/sign-in/social", {
    body: {
      provider: "github",
      callbackURL: "/projects",
      disableRedirect: true,
    },
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  assert(state);

  // Mock GitHub token exchange + profile + email endpoints.
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const href = String(input);
        if (href.includes("github.com/login/oauth/access_token")) {
          return Response.json({
            access_token: "gho_test_token",
            token_type: "bearer",
            scope: "read:user,user:email",
          });
        }
        if (href.includes("api.github.com/user/emails")) {
          return Response.json([
            {
              email: "oauth2fa@example.com",
              primary: true,
              verified: true,
            },
          ]);
        }
        if (href.includes("api.github.com/user")) {
          return Response.json({
            id: 424242,
            login: "oauth2fa",
            name: "OAuth User",
            email: "oauth2fa@example.com",
          });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const callback = await request(
    `/callback/github?code=gh_code_123&state=${encodeURIComponent(state)}`,
    { method: "GET" },
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe(
    "/login?twoFactor=1&redirectTo=%2Fprojects",
  );
  // No session created or leaked in cookies.
  expect(database.session).toHaveLength(0);
  expect(await (await request("/get-session")).json()).toBeNull();

  // Completing 2FA with the issued two_factor cookie creates the session.
  const verified = await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });
  expect(verified.status).toBe(200);
  expect(database.session).toHaveLength(1);
});

test("backup codes recover a 2FA sign-in once, and repeated failed attempts trigger account lockout", async () => {
  const { cookieJar, request, signInWithEmailOtp } = createTestAuth();

  await signInWithEmailOtp("recovery@example.com");
  const enable = await request("/two-factor/enable", {
    body: { method: "totp" },
  });
  const { totpURI, backupCodes } = (await enable.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });
  await request("/sign-out", { body: {} });
  cookieJar.clear();

  // Sign in with a backup code.
  await signInWithEmailOtp("recovery@example.com");
  const usedCode = backupCodes[0];
  assert(usedCode);
  const recovery = await request("/two-factor/verify-backup-code", {
    body: { code: usedCode },
  });
  expect(recovery.status).toBe(200);

  // Reusing the same backup code fails.
  await request("/sign-out", { body: {} });
  cookieJar.clear();
  await signInWithEmailOtp("recovery@example.com");
  const replay = await request("/two-factor/verify-backup-code", {
    body: { code: usedCode },
  });
  expect(replay.status).toBe(401);
  expect(await replay.json()).toMatchObject({ code: "INVALID_BACKUP_CODE" });

  // Trigger account lockout (10 consecutive failures across challenges).
  // 1 failure already recorded above; 9 more trigger the lock.
  for (let i = 0; i < 9; i++) {
    if (i === 4) {
      // Refresh challenge after 5 attempts on one challenge.
      cookieJar.clear();
      await signInWithEmailOtp("recovery@example.com");
    }
    const fail = await request("/two-factor/verify-totp", {
      body: { code: "000000" },
    });
    expect(fail.status).toBe(401);
  }

  // Even a fresh challenge with the valid TOTP code is now locked (429).
  cookieJar.clear();
  await signInWithEmailOtp("recovery@example.com");
  const locked = await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });
  expect(locked.status).toBe(429);
  expect(await locked.json()).toMatchObject({
    code: "ACCOUNT_TEMPORARILY_LOCKED",
  });
});

test("residual password sign-in still enforces 2FA", async () => {
  const { cookieJar, request } = createTestAuth();
  const password = "residual-password-123456";
  await request("/sign-up/email", {
    body: { email: "pw2fa@example.com", name: "PW User", password },
  });
  const enable = await request("/two-factor/enable", {
    body: { method: "totp", password },
  });
  const { totpURI } = (await enable.json()) as { totpURI: string };
  await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });
  await request("/sign-out", { body: {} });
  cookieJar.clear();

  const signIn = await request("/sign-in/email", {
    body: { email: "pw2fa@example.com", password },
  });
  expect(signIn.status).toBe(200);
  expect(await signIn.json()).toEqual({
    twoFactorRedirect: true,
    twoFactorMethods: ["totp"],
  });
  expect(await (await request("/get-session")).json()).toBeNull();

  const verify = await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });
  expect(verify.status).toBe(200);
});

test("2FA and session-revocation paths ignore stale cached session cookies", async () => {
  const { database, cookieHeader, request, signInWithEmailOtp } =
    createTestAuth();

  await signInWithEmailOtp("cache@example.com");
  const staleCookies = cookieHeader();
  expect(staleCookies).toContain("better-auth.session_data=");

  // Revoke session directly in DB (simulating revocation on another device).
  database.session.length = 0;

  // Authoritative 2FA and revoke paths strip session_data and reject the revoked session.
  const enable = await request("/two-factor/enable", {
    body: { method: "totp" },
    headers: { cookie: staleCookies },
    useJar: false,
  });
  expect(enable.status).toBe(401);

  const revoke = await request("/revoke-other-sessions", {
    body: {},
    headers: { cookie: staleCookies },
    useJar: false,
  });
  expect(revoke.status).toBe(401);
});

/** Encode a P-256 public key in minimal COSE_Key CBOR format (kty=2, alg=-7, crv=1, x, y). */
function encodeP256CoseKey(jwk: JsonWebKey): string {
  assert(jwk.x && jwk.y);
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  // CBOR map of 5 items:
  // 1 (kty): 2 (EC2)
  // 3 (alg): -7 (ES256 -> 0x26)
  // -1 (crv -> 0x20): 1 (P-256)
  // -2 (x -> 0x21): bstr(32)
  // -3 (y -> 0x22): bstr(32)
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  return cose.toString("base64");
}

test("passkey registration options, CRUD, and authentication (skipping 2FA for 2FA-enabled user)", async () => {
  const { database, cookieJar, request, signInWithEmailOtp } = createTestAuth();

  // Unauthenticated registration options fail with 401.
  expect(
    (await request("/passkey/generate-register-options", { method: "GET" }))
      .status,
  ).toBe(401);

  const signIn = await signInWithEmailOtp("passkey@example.com");
  const { user } = (await signIn.json()) as { user: { id: string } };

  // Enable 2FA on this account to prove passkey sign-in skips the TOTP challenge.
  const enable = await request("/two-factor/enable", {
    body: { method: "totp" },
  });
  const { totpURI } = (await enable.json()) as { totpURI: string };
  await request("/two-factor/verify-totp", {
    body: { code: await totpCodeFromUri(totpURI) },
  });

  // Authenticated registration options return expected RP config.
  const regOptionsRes = await request("/passkey/generate-register-options", {
    method: "GET",
  });
  expect(regOptionsRes.status).toBe(200);
  const regOptions = (await regOptionsRes.json()) as {
    rp: { id: string; name: string };
    challenge: string;
  };
  expect(regOptions.rp).toEqual({ id: "localhost", name: "Texfolia" });
  expect(regOptions.challenge).toBeTruthy();

  // Seed a real P-256 passkey credential for CRUD + WebAuthn verification testing.
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialID = Buffer.from("texfolia-test-credential-id-1").toString(
    "base64url",
  );
  database.passkey.push({
    id: "pk-test-1",
    name: "Laptop",
    publicKey: encodeP256CoseKey(jwk),
    userId: user.id,
    credentialID,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
    transports: "internal",
    createdAt: new Date(),
  });

  // List & rename passkey.
  const listed = await request("/passkey/list-user-passkeys", {
    method: "GET",
  });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject([
    { id: "pk-test-1", name: "Laptop" },
  ]);

  const renamed = await request("/passkey/update-passkey", {
    body: { id: "pk-test-1", name: "MacBook Touch ID" },
  });
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toMatchObject({
    passkey: { id: "pk-test-1", name: "MacBook Touch ID" },
  });

  // Sign out and authenticate with the passkey.
  await request("/sign-out", { body: {} });
  cookieJar.clear();
  database.session.length = 0;

  const authOptsRes = await request("/passkey/generate-authenticate-options", {
    method: "GET",
  });
  expect(authOptsRes.status).toBe(200);
  const authOpts = (await authOptsRes.json()) as {
    challenge: string;
    rpId: string;
  };
  expect(authOpts.rpId).toBe("localhost");

  // Construct a valid WebAuthn assertion signed with the P-256 private key.
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: authOpts.challenge,
      origin: "http://localhost:3000",
      crossOrigin: false,
    }),
  );
  const rpIdHash = createHash("sha256").update("localhost").digest();
  // Flags: UP (0x01) | UV (0x04) = 0x05; counter = 1 (big-endian uint32).
  const authenticatorData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x05, 0x00, 0x00, 0x00, 0x01]),
  ]);
  const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
  const signature = cryptoSign(
    "sha256",
    Buffer.concat([authenticatorData, clientDataHash]),
    privateKey,
  );

  const verified = await request("/passkey/verify-authentication", {
    body: {
      response: {
        id: credentialID,
        rawId: credentialID,
        type: "public-key",
        response: {
          authenticatorData: authenticatorData.toString("base64url"),
          clientDataJSON: clientDataJSON.toString("base64url"),
          signature: signature.toString("base64url"),
        },
        clientExtensionResults: {},
      },
    },
  });
  expect(verified.status).toBe(200);
  const verifiedBody = (await verified.json()) as {
    session?: { userId: string };
    twoFactorRedirect?: boolean;
  };
  // Passkey satisfies MFA directly without a TOTP challenge.
  expect(verifiedBody.twoFactorRedirect).toBeUndefined();
  expect(verifiedBody.session?.userId).toBe(user.id);
  expect(database.session).toHaveLength(1);

  // Delete passkey.
  const deleted = await request("/passkey/delete-passkey", {
    body: { id: "pk-test-1" },
  });
  expect(deleted.status).toBe(200);
  const afterDelete = await request("/passkey/list-user-passkeys", {
    method: "GET",
  });
  expect(await afterDelete.json()).toEqual([]);
});

test("loginSearch parses twoFactor flag alongside redirectTo", () => {
  expect(loginSearch({ twoFactor: "1", redirectTo: "/projects" })).toEqual({
    redirectTo: "/projects",
    error: undefined,
    twoFactor: true,
  });
  expect(loginSearch({ twoFactor: "0" })).toEqual({
    redirectTo: undefined,
    error: undefined,
    twoFactor: undefined,
  });
});
