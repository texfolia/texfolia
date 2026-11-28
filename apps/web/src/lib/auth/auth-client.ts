import { passkeyClient } from "@better-auth/passkey/client";
import { stripeClient } from "@better-auth/stripe/client";
import {
  emailOTPClient,
  lastLoginMethodClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const TWO_FACTOR_REQUIRED_EVENT = "texfolia:two-factor-required";

export const authClient = createAuthClient({
  plugins: [
    emailOTPClient(),
    lastLoginMethodClient(),
    organizationClient({ teams: { enabled: true } }),
    stripeClient({ subscription: true }),
    twoFactorClient({
      onTwoFactorRedirect() {
        if (typeof window === "undefined") return;
        const current = new URL(window.location.href);
        if (current.pathname === "/login") {
          window.dispatchEvent(new CustomEvent(TWO_FACTOR_REQUIRED_EVENT));
          return;
        }
        const redirectTo = `${current.pathname}${current.search}${current.hash}`;
        const target = new URL("/login", current.origin);
        target.searchParams.set("twoFactor", "1");
        if (redirectTo && redirectTo !== "/") {
          target.searchParams.set("redirectTo", redirectTo);
        }
        window.location.assign(target.toString());
      },
    }),
    passkeyClient(),
  ],
});
