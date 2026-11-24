---
title: Public auth abuse protection
---

Auth is configured in `apps/app/src/lib/auth/auth.ts`; only the product app
uses it. The login page supports
email OTP and GitHub, Google, GitLab, and Microsoft OAuth. Password sign-in and
OTP password reset remain available for existing credentials. Password signup
is disabled because the product does not use it, and creating an unverified
account would also trigger Stripe customer creation.

All paths below are relative to `/api/auth`. This inventory covers the
unauthenticated HTTP routes in Better Auth 1.7.15 and the configured plugins.

| Method and path                                                                                        | Side effects and controls                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/email-otp/send-verification-otp`                                                                | Sends sign-in, email-verification, or password-reset OTPs. Requires Turnstile. Limited to three requests per IP and path in 60 seconds, shared across OTP purposes.                                                     |
| POST `/email-otp/request-password-reset`                                                               | Sends a reset OTP for an existing account. Requires Turnstile; three requests per IP and path in 60 seconds.                                                                                                            |
| POST `/forget-password/email-otp`                                                                      | Deprecated reset alias, retained for compatibility. Same CAPTCHA and rate policy as the canonical reset sender.                                                                                                         |
| POST `/sign-in/email-otp`                                                                              | Requires a valid, expiring OTP before creating a verified account or session. Three requests per IP and path in 60 seconds; each OTP also has an attempt limit. New verified accounts trigger the Stripe customer hook. |
| POST `/email-otp/check-verification-otp`, `/email-otp/verify-email`, `/email-otp/reset-password`       | Require an OTP; do not send email. Three requests per IP and path in 60 seconds, plus the OTP attempt limit.                                                                                                            |
| POST `/sign-in/email`                                                                                  | Password verification and session creation for existing credentials. Three requests per IP and path in 10 seconds. No signup or outbound email.                                                                         |
| POST `/sign-in/social`                                                                                 | Starts OAuth or verifies a provider ID token. Three requests per IP and path in 10 seconds.                                                                                                                             |
| GET/POST `/callback/:id`                                                                               | Completes OAuth using provider proof and the OAuth state flow. Creating a user triggers the Stripe customer hook. Uses the default rate limit.                                                                          |
| GET `/get-session`, POST `/sign-out`, GET `/error`                                                     | Session lookup/refresh, session removal, or error redirect. No email or customer creation. Uses the default rate limit.                                                                                                 |
| GET `/verify-email`, GET `/reset-password/:token`, POST `/reset-password`, GET `/delete-user/callback` | Legacy token completion routes. Require signed or stored tokens before changing account state. Link email senders and account deletion are not configured. Uses the default rate limit.                                 |
| POST `/stripe/webhook`                                                                                 | Requires a valid Stripe webhook signature. Uses the default rate limit.                                                                                                                                                 |

The default rate limit is 100 requests per IP and path in 10 seconds. Limits run
before CAPTCHA verification, including on invalid and missing-token requests.
The reset alias has its own bucket; it does not share the canonical sender's
bucket. Limits use Better Auth's in-memory store, so they apply within a Worker
isolate, not globally across isolates or deployments. Turnstile is the required
control for every public email sender even when requests reach different isolates.

`cf-connecting-ip` is the only configured client IP header. Cloudflare supplies
this header in deployed Workers; caller-supplied `x-forwarded-for` values cannot
select a different bucket. Direct local requests without the header use Better
Auth's development loopback fallback.

The remaining organization, billing, account, and session-management endpoints
require a session and their applicable authorization checks. In particular,
`/organization/invite-member` requires organization permission before sending an
invitation. Subscription changes require account ownership or an organization
owner/admin role. OTP email change is disabled by plugin configuration.

These unused routes cannot send email or create accounts:

- POST `/sign-up/email` returns the same signup-disabled error for every address.
- POST `/request-password-reset` and `/send-verification-email` return 404 through
  `disabledPaths`; Texfolia uses the OTP senders instead.
- OTP creation and retrieval helpers are server-only and have no HTTP routes.

## Turnstile configuration

`TURNSTILE_HOSTNAMES` is a comma-separated list of exact hostnames, without
schemes, ports, paths, or wildcards. Whitespace is trimmed and names are lowercased.
If the variable is absent, the hostname of `BETTER_AUTH_URL` is used. Empty or
malformed lists fail during auth configuration. Local development allows
`localhost`. The production value is configured under `env.production` in
`apps/app/wrangler.jsonc`.

Every token must report an allowed hostname and action `auth-email`. The login
widget and server share the action constant in `auth-captcha.ts`. Missing tokens,
failed verification, missing/mismatched hostname or action, duplicate/expired
tokens, and provider outages fail before OTP delivery. Turnstile's Siteverify
service enforces token expiry and single use.

All successful OTP send requests return `{ "success": true }`, whether or not
an account exists. Sign-in OTPs are delivered to new addresses so recipients can
create an account after proving email ownership. Verification and reset requests
for unknown addresses have the same response but do not deliver an email.
CAPTCHA failures and rate-limit responses do not include account information.
These are response-body guarantees; local tests do not establish constant timing.

## Verification

From the repository root:

```sh
bun test apps/app/src/lib/auth/auth-abuse.test.ts
```

The suite uses the production auth options, Better Auth's HTTP handler, a memory
adapter, captured OTP delivery, and mocked external Turnstile/Stripe boundaries.
It checks direct routes and aliases, valid/missing/invalid tokens, hostname and
action enforcement, provider failures, generic responses, parallel rate limits,
trusted IP handling, path normalization, disabled signup, and the Stripe hook
only after OTP proof. No external provider requests are made.

Existing OTP and organization tests cover code consumption, password reset,
expiry, invitation permissions, and billing authorization:

```sh
bun test apps/app/src/lib/auth/auth-otp.test.ts apps/app/src/lib/auth/auth.test.ts
```
