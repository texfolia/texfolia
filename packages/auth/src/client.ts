import { stripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/client";
import {
  emailOTPClient,
  lastLoginMethodClient,
  organizationClient,
} from "better-auth/client/plugins";

export const AUTH_EMAIL_CAPTCHA_ACTION = "auth-email";

// The framework-neutral Better Auth client. `app` calls it on its own origin;
// `web` passes the app origin and sends cookies cross-origin.
export function createTexfoliaAuthClient(options: { baseURL?: string } = {}) {
  return createAuthClient({
    ...(options.baseURL
      ? {
          baseURL: options.baseURL,
          fetchOptions: { credentials: "include" as const },
        }
      : {}),
    plugins: [
      emailOTPClient(),
      lastLoginMethodClient(),
      organizationClient(),
      stripeClient({ subscription: true }),
    ],
  });
}

export type TexfoliaAuthClient = ReturnType<typeof createTexfoliaAuthClient>;
