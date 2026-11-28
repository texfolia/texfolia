---
title: Public auth abuse protection
---

Auth is configured in `apps/app/src/lib/auth/auth.ts`; only the product app
uses it. The login page supports
passkeys (WebAuthn, including Conditional UI), email OTP, and GitHub, Google,
GitLab, and Microsoft OAuth, with optional TOTP two-factor authentication and
single-use recovery backup codes. Password sign-in and
OTP password reset remain available for existing credentials. Password signup
is disabled because the product does not use it, and creating an unverified
account would also trigger Stripe customer creation.

All paths below are relative to `/api/auth`. This inventory covers the
unauthenticated HTTP routes in Better Auth 1.7.15 and the configured plugins.

| Method and path                                                                                  | Side effects and controls                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST `/email-otp/send-verification-otp`                                                          | Sends sign-in, email-verification, or password-reset OTPs. Requires Turnstile. Limited to three requests per IP and path in 60 seconds, shared across OTP purposes.                                                                             |
| POST `/email-otp/request-password-reset`                                                         | Sends a reset OTP for an existing account. Requires Turnstile; three requests per IP and path in 60 seconds.                                                                                                                                    |
| POST `/forget-password/email-otp`                                                                | Deprecated reset alias, retained for compatibility. Same CAPTCHA and rate policy as the canonical reset sender.                                                                                                                                 |
| POST `/sign-in/email-otp`                                                                        | Requires a valid, expiring OTP, stored hashed, before creating a verified account or session. Three requests per IP and path in 60 seconds; each OTP also has an attempt limit. New verified accounts trigger the Stripe customer hook.         |
| POST `/email-otp/check-verification-otp`, `/email-otp/verify-email`, `/email-otp/reset-password` | Require an OTP; do not send email. Three requests per IP and path in 60 seconds, plus the OTP attempt limit.                                                                                                                                    |
| POST `/sign-in/email`                                                                            | Password verification and session creation for existing credentials. Requires Turnstile. Three requests per IP and path in 10 seconds. No signup or outbound email.                                                                             |
| POST `/sign-in/social`                                                                           | Starts OAuth or verifies a provider ID token. Three requests per IP and path in 10 seconds. Enforces 2FA challenge if the account has 2FA enabled and no valid trusted-device cookie.                                                           |
| GET/POST `/callback/:id`                                                                         | Completes OAuth using provider proof and the OAuth state flow. Creating a user triggers the Stripe customer hook. Discards the pending session and redirects to `/login?twoFactor=1` when 2FA is required. Uses the default rate limit.         |
| POST `/two-factor/verify-totp`, `/two-factor/verify-backup-code`                                 | Completes a pending 2FA challenge using a signed `two_factor` cookie and stored verification token. Three requests per IP and path in 10 seconds, 5 attempts per challenge, and temporary account lockout after 10 consecutive failures.        |
| GET `/passkey/generate-authenticate-options`, POST `/passkey/verify-authentication`              | Issues a single-use WebAuthn challenge and verifies a cryptographic passkey assertion scoped to the app origin (`rpID` / `origin` from `BETTER_AUTH_URL`). No email or account creation. Ten requests per IP and path in 60 seconds.            |
| GET `/get-session`, POST `/sign-out`, GET `/error`                                               | Session lookup/refresh, session removal, or error redirect. No email or customer creation. Uses the default rate limit, except that `/get-session` has none.                                                                                    |
| GET `/verify-email`, GET `/reset-password/:token`, POST `/reset-password`                        | Legacy token completion routes. Require signed or stored tokens before changing account state. No link email senders are configured for them. Uses the default rate limit.                                                                      |
| GET `/delete-user/callback`                                                                      | Completes an account deletion from its confirmation email. Requires a session and that user's stored token. Redirects to Account settings without deleting while the account is the only owner of an organization. Uses the default rate limit. |
| POST `/stripe/webhook`                                                                           | Requires a valid Stripe webhook signature. Has no rate limit.                                                                                                                                                                                   |

The default rate limit is 100 requests per IP and path in 10 seconds. Limits run
before CAPTCHA verification, including on invalid and missing-token requests.
The reset alias has its own bucket; it does not share the canonical sender's
bucket. Counters live in the `rate_limit` Postgres table, so every Worker isolate
shares them. Turnstile is also required for every public email sender.

`cf-connecting-ip` is the only configured client IP header. Cloudflare supplies
this header in deployed Workers; caller-supplied `x-forwarded-for` values cannot
select a different bucket. Direct local requests without the header use Better
Auth's development loopback fallback.

The remaining organization, billing, account, and session-management endpoints
require a session and their applicable authorization checks. In particular,
`/organization/invite-member` requires organization permission before sending an
invitation, and only owners invite owners and admins. `/delete-user` emails a
confirmation link and is refused while the account is the only owner of an
organization. Subscription changes require account ownership or an organization
owner/admin role. `/email-otp/request-email-change` also requires Turnstile, which
runs before the session check, and allows three requests per IP in 60 seconds.

## Session cache

`session.cookieCache` keeps a signed copy of the session and user in a cookie for
five minutes, so most requests do not read the session from Postgres. A session
that was revoked, or whose user was deleted, keeps working for up to five minutes
where only the cookie is checked. These always read the database:

- Project access and roles, on every request.
- WebSocket upgrades, through `requestPrincipal`. Reading the database there also
  sets no cookie, which would make TanStack Start rebuild the 101 response and fail
  the upgrade.
- `/organization/*`, `/subscription/*`, `/two-factor/*`, `/passkey/*`, and session
  revocation routes (`/revoke-session`, `/revoke-other-sessions`, `/revoke-sessions`),
  whose requests lose the cached cookie in `beforeAuth`.
- Better Auth's own account, email, and deletion endpoints.

## Unused routes

These unused routes cannot send email or create accounts:

- POST `/sign-up/email` returns the same signup-disabled error for every address.
- POST `/request-password-reset` and `/send-verification-email` return 404 through
  `disabledPaths`; Texfolia uses the OTP senders instead. The same list keeps
  OAuth tokens on the server by disabling `/get-access-token` and `/refresh-token`,
  and disables `/two-factor/send-otp` and `/two-factor/verify-otp` because 2FA uses
  TOTP and backup codes rather than same-channel email OTP.
- OTP creation and retrieval helpers, and `viewBackupCodes`, are server-only and
  have no HTTP routes.

## Turnstile configuration

`TURNSTILE_HOSTNAMES` is a comma-separated list of exact hostnames, without
schemes, ports, paths, or wildcards. Whitespace is trimmed and names are lowercased.
If the variable is absent, the hostname of `BETTER_AUTH_URL` is used. Empty or
malformed lists fail during auth configuration. Local development allows
`localhost`. The production value is configured under `env.production` in
`apps/app/wrangler.jsonc`.

Every token must report an allowed hostname and action `auth-email`. The login
and account settings widgets and the server share the action constant in
`captcha.ts`. Missing tokens,
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
