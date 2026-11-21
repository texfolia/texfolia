import { AUTH_EMAIL_CAPTCHA_ACTION } from "@texfolia/auth/client";
import {
  emailOTPClient,
  lastLoginMethodClient,
  organizationClient,
} from "better-auth/client/plugins";
import { stripeClient } from "@better-auth/stripe/client";
import { createAuthClient } from "better-auth/react";

export { AUTH_EMAIL_CAPTCHA_ACTION };

export const authClient = createAuthClient({
  plugins: [
    emailOTPClient(),
    lastLoginMethodClient(),
    organizationClient(),
    stripeClient({ subscription: true }),
  ],
});
