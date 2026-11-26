import { stripeClient } from "@better-auth/stripe/client";
import {
  emailOTPClient,
  lastLoginMethodClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [
    emailOTPClient(),
    lastLoginMethodClient(),
    organizationClient({ teams: { enabled: true } }),
    stripeClient({ subscription: true }),
  ],
});
