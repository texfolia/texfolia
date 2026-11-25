---
title: Web security headers
---

The [app Worker](../../../../app/src/worker.ts) applies security headers to every
TanStack Start HTTP response, including HTML, APIs, redirects, and errors.
It passes response bodies through as streams and leaves WebSocket upgrades intact.
Static assets served directly by Cloudflare do not pass through this wrapper.
[public/_headers](../../../../app/public/_headers) adds `nosniff` and lets browsers
keep `/assets/*`, `/core/*`, and `/dictionaries/*` forever. Vite hashes the names in
`/assets`. The other two carry their package's version in the URL; see
`latexToolsVersion` and `spellingDictionaries`. Update those with the packages; a
unit test fails until they match.

Build files whose URL names their build are `private, max-age=31536000, immutable`.
Signing out and deleting the account send `Clear-Site-Data: "cache"`, so the next
user of the browser does not find them.

The [policy](../../../../app/src/lib/security-headers.ts) enforces CSP in production.
It sets `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: strict-origin-when-cross-origin`, and
`X-Content-Type-Options: nosniff`. `Strict-Transport-Security` covers the app's
host and its subdomains for a year. Development retains the baseline headers but
omits CSP, because Vite injects scripts without nonces, and HSTS.

Each request gets a fresh, cryptographically random 128-bit nonce. The Worker
replaces any client-supplied nonce header before the router reads it. TanStack
Router applies that nonce to hydration scripts and head scripts, including the
theme bootstrap, and restores it from the document when hydrating.

The policy allows these application requirements:

- Same-origin scripts and workers, plus `wasm-unsafe-eval` for WebAssembly.
  JavaScript `eval` and unapproved inline scripts and event handlers remain blocked.
- Turnstile scripts and frames from `https://challenges.cloudflare.com`, following
  [Cloudflare's CSP guidance](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).
- Inline styles for CodeMirror, dockview, React positioning, and user themes.
- Same-origin HTTP requests and the current origin's WebSocket endpoint for
  collaboration and compile streams.
- Blob URLs for PDF workers, PDF fonts, and local PDF loading; data URLs for
  images and fonts; HTTPS images for user avatars.

Stripe checkout and billing portal navigation, and OAuth provider navigation,
use top-level redirects. They do not require third-party script, frame, or
connection allowlists in the app document. Embedded Stripe would require a
policy review.

## Marketing site

`apps/web` sends its own [policy](../../../../web/src/lib/security-headers.ts). Its
Worker adds the headers to rendered responses. Cloudflare serves prerendered
pages and assets without the Worker, so `apps/web/public/_headers` repeats the
values, and a unit test keeps them equal. The CSP allows inline scripts because
prerendered pages cannot carry a per-request nonce; the site has no sessions or
user-written content. Its HSTS header does not cover other `texfolia.com`
subdomains.

## Verification

Run `bun run --cwd apps/app build` followed by
`bun run --cwd apps/app test:production-assets` to verify real production HTML
and API headers, matching nonces, blocked script injection, fonts, formatter
WebAssembly, PDF rendering, and the login flow with external-service fixtures.
This check runs in CI without a database. The authenticated UI and pricing
suites also fail on unexpected CSP console errors.
