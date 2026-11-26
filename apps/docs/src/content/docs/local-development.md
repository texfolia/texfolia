---
title: Local development
---

Texfolia has two environments: local development and production. Local development
uses local Postgres, Docker compiler containers, and Wrangler's local storage and
Durable Object emulation through Vite. Production resources and secrets belong
only in the Cloudflare deployment configuration and production secret store.
Never put production database URLs or secrets in local environment files.

Install [Bun](https://bun.sh) 1.4.4, [Docker](https://www.docker.com) with Compose, and the [Stripe CLI](https://docs.stripe.com/stripe-cli). Start Docker before running the app. Postgres, the Workers runtime, compiler storage, and email delivery run locally. API integrations use your configured credentials.

```sh
git clone https://github.com/texfolia/texfolia.git
cd texfolia
bun install
bun run setup
```

`bun run setup` copies each `.env.example` to `.env` (in `apps/app`, `apps/web` and
`packages/db`) without overwriting existing files, fills in a random
`BETTER_AUTH_SECRET`, starts Postgres and applies the schema. Run it again at any time.

In `apps/app/.env`, configure a Stripe sandbox `STRIPE_SECRET_KEY` and recurring `STRIPE_PRO_PRICE_ID` and `STRIPE_TEAM_PRICE_ID`, your Turnstile site key and secret, and credentials for the OAuth providers you use. Secrets are required configuration; the app does not generate fallback credentials or replace Stripe with a mock.

Run `bun run --cwd apps/app billing:setup` to create or reuse the $15 Pro and $20/user Team monthly prices, then copy its price IDs into `apps/app/.env`. See [subscription billing setup and verification](/billing/) for shared billing, portal configuration, and sandbox checks.

Set `DATABASE_URL` in `packages/db/.env` to your local database. Keep `DATABASE_URL` and `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in `apps/app/.env` pointed at the same database. The example values match the Compose Postgres credentials and use `db` on `localhost:5432`.

Local database, compiler, and engine URLs must use `localhost`, `127.0.0.1`, or
`[::1]`. Startup rejects cloud URLs and `CLOUDFLARE_ENV` overrides. Vite disables
remote bindings. `db:push` and `auth:schema` also require a local database.
Keep local integration credentials separate from production credentials.

## Forward Stripe webhooks

Log the Stripe CLI into the same sandbox as the app's Stripe API key. In a separate terminal, run:

```sh
stripe login
stripe listen --forward-to localhost:3000/api/auth/stripe/webhook
```

The listener forwards events to `localhost:3000/api/auth/stripe/webhook`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET` in `apps/app/.env`, then start or restart the app. Keep the listener running while testing subscriptions. Use the listener's signing secret for local forwarding, rather than a dashboard webhook endpoint's secret. This follows [Better Auth's local webhook setup](https://better-auth.com/docs/plugins/stripe#testing-webhooks-locally).

## Start the app

Start every app:

```sh
bun run dev
```

This starts Postgres, waits for its health check, then runs each workspace's
`dev` script through Turbo:

| App            | Command                | URL                                     |
| -------------- | ---------------------- | --------------------------------------- |
| Product app    | `bun run dev:app`      | [localhost:3000](http://localhost:3000) |
| Marketing site | `bun run dev:web`      | [localhost:4321](http://localhost:4321) |
| Documentation  | `bun run dev:docs`     | [localhost:4322](http://localhost:4322) |
| Compiler       | `bun run dev:compiler` | `http://localhost:8080`                 |

To run one app on its own, use its command from the table. `dev:app` also
starts Postgres. The product app needs the compiler to build PDFs, so run
`dev:compiler` in a second terminal, or use `bun run dev`. You can also pass
any [Turbo filter](https://turborepo.com/docs/reference/run#--filter-string):
`bun run dev --filter=app --filter=compiler`.

The compiler builds the LaTeX engine image before it starts. The first build
downloads and caches the base LaTeX packages; additional packages may need a
network connection when first used. The compiler starts a Docker engine
container for the first compile and reuses it, up to 20 at once, until the pool
has been idle for ten minutes.

Press Ctrl+C to stop the apps. Postgres and engine containers keep running:

```sh
bun run db:stop
docker ps -aq --filter label=texfolia.compiler | xargs docker rm -f
```

Database data persists in the Compose volume. Build history and artifacts
persist with the product app's other local Worker storage, and the engine pool
persists in `apps/compiler/.cache/pool.sqlite`.

## Change the schema or seed data

`bun run dev` never changes the schema or seeds data. Run `bun run db:push`
after changing the schema, and `bun run db:seed` to add the original templates
to Postgres and local R2. Template previews run as project builds on the same
compiler. See [Template lifecycle](/templates/).

## Local services

Cloudflare simulates the email binding locally and logs the file containing
each sign-in code or invitation. You can also inspect sent messages in
[Local Explorer](http://localhost:3000/cdn-cgi/local/explorer). Auth uses the same
plugins and login flow in every environment, including Stripe customer setup
and webhook signature verification.

The web app reads `env.HYPERDRIVE.connectionString` in both environments. Local
development uses `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` from
`apps/app/.env`. Compiler requests use loopback HTTP locally and a service
binding on Cloudflare. The compiler stores no jobs or PDFs.

See the [database guide](../../../../../packages/db/README.md) for standalone schema operations
and integration checks. For deployed environments, follow
[Set up Neon and Hyperdrive](/database-deployment/).

## Compile your first PDF

1. Open [localhost:3000](http://localhost:3000) and sign in.
2. Create a project and paste the example below into `main.tex`.
3. Press Cmd/Ctrl+S or select **File → Save & compile**, then open the PDF under `out` in Files.

```latex
\documentclass{article}
\begin{document}
Hello from Texfolia!
\end{document}
```
