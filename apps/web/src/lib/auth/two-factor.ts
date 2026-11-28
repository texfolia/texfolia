import type { GenericEndpointContext } from "better-auth";
import { deleteSessionCookie, expireCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";

const TWO_FACTOR_COOKIE_NAME = "two_factor";
const TRUST_DEVICE_COOKIE_NAME = "trust_device";
const TRUST_DEVICE_MAX_AGE = 2_592_000; // 30 days (matches Better Auth default)
const TWO_FACTOR_COOKIE_MAX_AGE = 600; // 10 minutes (matches Better Auth default)

// oxlint-disable-next-line no-control-regex -- Redirect targets must reject control characters.
const safeRelativeRedirect = /^\/(?!\/)[^\u0000-\u0020\\]*$/;

async function signTrustDeviceToken(
  secret: string,
  data: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(data)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function isTwoFactorGatedPath(path: string): boolean {
  return (
    path === "/sign-in/email-otp" ||
    path === "/sign-in/social" ||
    path.startsWith("/callback/")
  );
}

function extractRedirectLocation(ctx: GenericEndpointContext): string | null {
  const context = ctx.context as GenericEndpointContext["context"] & {
    returned?: { headers?: Headers | Record<string, string> };
    responseHeaders?: Headers;
  };
  const headers = context.returned?.headers;
  if (headers instanceof Headers) {
    return headers.get("location");
  }
  if (headers && typeof headers === "object") {
    return headers.location ?? headers.Location ?? null;
  }
  return context.responseHeaders?.get("location") ?? null;
}

function resolveSafeRedirectTarget(
  location: string | null,
  baseURL: string,
): string | null {
  if (!location) return null;
  if (safeRelativeRedirect.test(location)) return location;
  try {
    const parsed = new URL(location, baseURL);
    const origin = new URL(baseURL).origin;
    if (parsed.origin !== origin) return null;
    const relative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return safeRelativeRedirect.test(relative) ? relative : null;
  } catch {
    return null;
  }
}

/**
 * Enforces Better Auth's 2FA challenge on passwordless and OAuth sign-in paths
 * (`/sign-in/email-otp`, `/sign-in/social`, `/callback/:id`).
 *
 * Better Auth's built-in `twoFactor` plugin only intercepts credential sign-in
 * (`/sign-in/email`, `/sign-in/username`, `/sign-in/phone-number`). Passkey
 * sign-in (`/passkey/verify-authentication`) is intentionally not gated here
 * because a user-verifying passkey already satisfies MFA.
 */
export async function enforceTwoFactorOnSignIn(
  ctx: GenericEndpointContext,
): Promise<Response | undefined> {
  if (!isTwoFactorGatedPath(ctx.path)) return;
  const data = ctx.context.newSession;
  if (!data) return;

  const user = data.user as { id: string; twoFactorEnabled?: boolean | null };
  if (!user.twoFactorEnabled) return;

  const trustDeviceCookieAttrs = ctx.context.createAuthCookie(
    TRUST_DEVICE_COOKIE_NAME,
    { maxAge: TRUST_DEVICE_MAX_AGE },
  );
  const trustDeviceCookie = await ctx.getSignedCookie(
    trustDeviceCookieAttrs.name,
    ctx.context.secret,
  );
  if (trustDeviceCookie) {
    const [token, trustIdentifier] = trustDeviceCookie.split("!");
    if (token && trustIdentifier) {
      const expected = await signTrustDeviceToken(
        ctx.context.secret,
        `${user.id}!${trustIdentifier}`,
      );
      if (token === expected) {
        const verificationRecord =
          await ctx.context.internalAdapter.findVerificationValue(
            trustIdentifier,
          );
        if (
          verificationRecord &&
          verificationRecord.value === user.id &&
          verificationRecord.expiresAt > new Date()
        ) {
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(
            trustIdentifier,
          );
          const newTrustIdentifier = `trust-device-${generateRandomString(32)}`;
          const newToken = await signTrustDeviceToken(
            ctx.context.secret,
            `${user.id}!${newTrustIdentifier}`,
          );
          await ctx.context.internalAdapter.createVerificationValue({
            value: user.id,
            identifier: newTrustIdentifier,
            expiresAt: new Date(Date.now() + TRUST_DEVICE_MAX_AGE * 1000),
          });
          const newTrustDeviceCookie = ctx.context.createAuthCookie(
            TRUST_DEVICE_COOKIE_NAME,
            { maxAge: TRUST_DEVICE_MAX_AGE },
          );
          await ctx.setSignedCookie(
            newTrustDeviceCookie.name,
            `${newToken}!${newTrustIdentifier}`,
            ctx.context.secret,
            trustDeviceCookieAttrs.attributes,
          );
          return;
        }
      }
    }
    expireCookie(ctx, trustDeviceCookieAttrs);
  }

  // Discard the pending session and scrub its cookies before issuing the 2FA challenge.
  deleteSessionCookie(ctx, true);
  await ctx.context.internalAdapter.deleteSession(data.session.token);
  ctx.context.setNewSession(null);

  const twoFactorCookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, {
    maxAge: TWO_FACTOR_COOKIE_MAX_AGE,
  });
  const identifier = `2fa-${generateRandomString(20)}`;
  const expiresAt = new Date(Date.now() + TWO_FACTOR_COOKIE_MAX_AGE * 1000);
  await ctx.context.internalAdapter.createVerificationValue({
    value: user.id,
    identifier,
    expiresAt,
  });
  await ctx.context.internalAdapter.createVerificationValue({
    value: "0",
    identifier: `2fa-attempts-${identifier}`,
    expiresAt,
  });
  await ctx.setSignedCookie(
    twoFactorCookie.name,
    identifier,
    ctx.context.secret,
    twoFactorCookie.attributes,
  );

  const twoFactorMethods: string[] = [];
  const userTotp = await ctx.context.adapter.findOne<{ verified?: boolean }>({
    model: "twoFactor",
    where: [{ field: "userId", value: user.id }],
  });
  if (userTotp && userTotp.verified !== false) {
    twoFactorMethods.push("totp");
  }

  if (ctx.path.startsWith("/callback/")) {
    const baseURL =
      typeof ctx.context.options.baseURL === "string"
        ? ctx.context.options.baseURL
        : ctx.context.baseURL;
    const redirectTarget = resolveSafeRedirectTarget(
      extractRedirectLocation(ctx),
      baseURL,
    );
    const params = new URLSearchParams({ twoFactor: "1" });
    if (redirectTarget) params.set("redirectTo", redirectTarget);
    throw ctx.redirect(`/login?${params.toString()}`);
  }

  return ctx.json({
    twoFactorRedirect: true,
    twoFactorMethods,
  }) as unknown as Response;
}
