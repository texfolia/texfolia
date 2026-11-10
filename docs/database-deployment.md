# Set up Neon and Hyperdrive

Application auth and database access use the same code in every environment. Configure real API credentials for local development as well as deployed environments. Local development runs Postgres and the Workers runtime locally and uses the Stripe CLI to forward webhooks; no auth plugins are disabled.

Cloud resources have not been provisioned yet. The production and staging bindings in `apps/web/wrangler.jsonc` contain placeholders. Complete these steps before deploying either environment.

## Create the databases

1. Create a Neon project named `texfolia` in your chosen provider and region. Record the region for Worker placement.
2. Use the `main` branch for production. Create a `staging` branch for staging. Create it before production contains private data, or use a schema-only branch.
3. Obtain a direct, unpooled Postgres connection string for each branch. Store credentials in your secret manager. Hyperdrive supplies connection pooling, so use the origin database endpoint.
4. Before deployment, generate and review migrations from the current schema with `bun run db:generate`. Apply the reviewed migrations to each branch with `DATABASE_URL` set to that branch's direct connection string using `bun run db:migrate`. There are currently no generated migration artifacts in the repository.

See [Neon's Hyperdrive setup](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/) for database access requirements.

## Create Hyperdrive configurations

Create one configuration for each branch in the Cloudflare dashboard. Name them `texfolia-production` and `texfolia-staging`. Use each branch's direct Postgres credentials, enable TLS, and disable query caching on both configurations.

For CLI provisioning, the installed Wrangler supports `wrangler hyperdrive create <name> --caching-disabled`. Use the dashboard to enter credentials without putting database passwords in shell history. Verify the resulting configuration has `caching.disabled: true` before deployment.

Replace the corresponding Hyperdrive ID placeholders in `apps/web/wrangler.jsonc`. The IDs are not secrets. Leave the local binding pointed at local Postgres.

Caching stays disabled for auth, sessions, permissions, billing, and reads after writes. Hyperdrive does not invalidate cached reads after a write. If public queries later need caching, add a second binding and send only those queries through it.

## Configure each Worker environment

In each environment in `apps/web/wrangler.jsonc`:

1. Set `placement.region` to the actual database provider and region. For example, a Neon database in AWS us-east-1 uses `"placement": { "region": "aws:us-east-1" }`. This example is not a selected deployment region.
2. Verify the compiler service name. Deploy a separate staging compiler before using `texfolia-compiler-staging`.
3. Replace the staging hostname placeholder and configure the auth URL, OAuth callbacks, Turnstile hostnames, and verified email sender for that environment.
4. Set the auth, OAuth, Turnstile, and Stripe secrets in each environment through Wrangler or the Cloudflare dashboard. Runtime database credentials stay in Hyperdrive, not a Worker `DATABASE_URL` secret.

The Cloudflare Vite plugin selects bindings at build time. Build for the intended environment, then deploy the resulting configuration:

```sh
bun run build:staging
bunx turbo run deploy --filter=web --only
```

Use `bun run build:production` for production. The `--only` deploy skips build
dependencies so it uses the environment selected by the preceding build.
Rebuild when switching environments. Passing `--env` only at deploy time does not retarget an already-built Worker.

Before deployment, run the repository checks and `wrangler deploy --dry-run` against the selected build. After deployment, verify email sign-in, a fresh session, project creation, and compilation in that environment. A local test does not verify a provisioned Hyperdrive pool or Neon branch.

See [Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/), [Worker placement](https://developers.cloudflare.com/workers/configuration/placement/), and [Vite Cloudflare environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/) for the configuration rules.
