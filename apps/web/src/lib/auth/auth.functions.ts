import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { account } from "@texfolia/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";

export const getSession = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const headers = getRequestHeaders();
    const session = await context.auth.api.getSession({ headers });

    return session;
  },
);

export const ensureSession = createServerFn({ method: "GET" }).handler(
  async ({ context }) => {
    const headers = getRequestHeaders();
    const session = await context.auth.api.getSession({ headers });

    if (!session) {
      throw new Error("Unauthorized");
    }

    return session;
  },
);

export const getAccountSecurityState = createServerFn({
  method: "GET",
}).handler(async ({ context }) => {
  const headers = getRequestHeaders();
  const session = await context.auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  const credentialAccount = await context.db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, session.user.id),
        eq(account.providerId, "credential"),
        isNotNull(account.password),
      ),
    )
    .limit(1);

  return {
    twoFactorEnabled: Boolean(session.user.twoFactorEnabled),
    hasPassword: credentialAccount.length > 0,
  };
});

export const viewTwoFactorBackupCodes = createServerFn({
  method: "POST",
}).handler(async ({ context }) => {
  const headers = getRequestHeaders();
  const session = await context.auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  if (!session.user.twoFactorEnabled) {
    throw new Error("Two-factor authentication is not enabled.");
  }

  const result = await context.auth.api.viewBackupCodes({
    body: { userId: session.user.id },
  });

  return { backupCodes: result.backupCodes };
});
