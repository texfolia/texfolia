# Set up Neon and Hyperdrive

Use this guide at the first production deploy. Cloud provisioning and baseline
migration generation remain deferred under
[NAT-198](https://linear.app/nbaby/issue/NAT-198).
For daily development, follow the [local setup](../README.md#local-development).
Local development and CI continue to use plain Postgres and `db:push`.

## Prepare the baseline at launch

1. Finish the v1 schema changes and pass the repository checks, including the web
   production build and the plain-Postgres CI job.
2. Generate the baseline from that schema with `bun run db:generate` from the
   repository root. Review the SQL and commit the generated `packages/db/drizzle`
   directory, including its snapshots, before deploying.
3. Apply `bun run db:migrate` to an empty, isolated local Postgres database with
   `DATABASE_URL` set to that database. Run the integration checks in the
   [database guide](../packages/db/README.md#verify-plain-postgres),
   [source-storage guide](../apps/web/README.md#local-development-and-rollout),
   and [template guide](templates.md#verification).
4. On that disposable database, run `bun run db:push` and confirm it reports no
   schema changes. Investigate any difference before proceeding.
5. Add `db:migrate` to the deployment workflow before either Worker deploys.
   Make a migration failure stop deployment. Keep `DATABASE_URL` scoped to the
   target database and use its direct connection with TLS.

The current deploy scripts do not run database migrations. Complete the workflow
change at launch. After the baseline is committed, generate a new reviewed
migration for each schema change. Preserve migrations already applied to staging
or production. See [Drizzle migrations](https://orm.drizzle.team/docs/migrations).

The repository has no SQL scripts or generated migrations before production
setup. For a new production database, apply the baseline once. For any existing
deployment, inspect its actual schema and migration history, then prepare and
review the required upgrade separately.

## Provision the databases and Hyperdrive

1. Create a Neon project in the chosen database region. Use `main` for production
   and create a `staging` branch before production receives user data. Record the
   provider and region for Worker placement. See [Neon branches](https://neon.com/docs/manage/branches).
2. Save each branch's direct Postgres connection string in the deployment secret
   store. Turn off Neon's connection-pooling option when retrieving the
   Hyperdrive origin connection. Follow the
   [Neon connection guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/).
3. In the intended Cloudflare account, create separate Hyperdrive configurations
   for those branch connections. Disable query caching on both configurations
   before binding them to a Worker. Keep credentials out of tracked files and
   command history.
4. Verify each configuration's origin branch and `caching.disabled` value in the
   dashboard or with the project-local `wrangler hyperdrive get` command. Both
   must have caching disabled. Record their IDs for the bindings.

Caching belongs to the Hyperdrive configuration, not the Wrangler binding.
Cloudflare enables it by default. See
[Disable caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/#disable-caching)
for the `--caching-disabled` option when creating or updating configurations.

## Configure each Worker environment

Edit `apps/web/wrangler.jsonc` before building the deployment artifact.

1. Replace `env.production.hyperdrive` and `env.staging.hyperdrive` placeholder
   IDs with the corresponding cache-disabled configurations. Keep the binding
   name `HYPERDRIVE` so all application queries use it.
2. Add a `placement` setting to each environment with the matching database
   region. For example, use `"placement": { "region": "aws:us-east-1" }` only
   for a database in that region. See
   [Placement hints](https://developers.cloudflare.com/workers/configuration/placement/#configure-explicit-placement-hints).
3. Replace `<staging hostname>` in staging's `TURNSTILE_HOSTNAMES`. Configure the
   actual routes, auth origins, Turnstile keys, OAuth callbacks, Stripe settings,
   email delivery, and secrets for each deployed hostname.
4. Provision `texfolia-sources` and `texfolia-sources-staging`. Keep their existing
   environment bindings independent. Provision compiler buckets and queues using
   the [compiler deployment guide](../apps/compiler/README.md#deploy-to-cloudflare).
5. Configure a separate staging compiler before deploying staging. The current
   compiler configuration defines only `texfolia-compiler`, while the web staging
   binding expects `texfolia-compiler-staging`. Give the staging compiler its own
   bucket and queues. Do not point it at production storage or queue consumers.
6. Run `bun run cf:typegen` after changing bindings.

Keep the default web configuration for local development. Its placeholder
Hyperdrive ID works with the local connection override and is not a deploy
target. Keep `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` pointed at
local Postgres. Local R2 and email remain Wrangler simulations.

## Migrate, deploy, and verify each environment

1. Run the reviewed, committed migrations with `DATABASE_URL` set to the target
   branch's direct connection. Never use `db:push` against staging or production.
2. Deploy that environment's compiler before its web Worker.
3. Build the web app with `CLOUDFLARE_ENV=staging` or `CLOUDFLARE_ENV=production`
   set at build time. Inspect the generated Wrangler configuration for the Worker
   name, Hyperdrive ID, source bucket, and compiler service before deploying it.
   Deploy the artifact built for that environment. Selecting an environment only
   at deploy time does not retarget the Vite build. See
   [Cloudflare Vite environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/).
4. Seed the original templates using the target database and source bucket as
   described in [Seed original templates](templates.md#seed-original-templates).
5. Verify sign-in, project creation, source save and reload, collaboration,
   compilation, PDF retrieval, and template copying on staging before production.
   Confirm a saved write is visible immediately and recheck that Hyperdrive
   caching is disabled. Inspect Worker logs for database and binding errors.
6. Repeat the migration, deployment, seed, and verification steps for production
   using its own configuration and secrets.

Treat `bun run deploy` as incomplete launch tooling until the migration step and
environment targeting above are wired in. It currently builds the default web
configuration and deploys the default compiler. Completing this guide's launch
steps is required before closing NAT-198.
