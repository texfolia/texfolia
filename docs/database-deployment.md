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
migration for each schema change. Preserve migrations already applied to production. See [Drizzle migrations](https://orm.drizzle.team/docs/migrations).

The repository has no SQL scripts or generated migrations before production
setup. For a new production database, apply the baseline once. For any existing
deployment, inspect its actual schema and migration history, then prepare and
review the required upgrade separately.

## Provision the production database and Hyperdrive

1. Create a Neon project in the chosen database region. Use `main` for production.
   Record the provider and region for Worker placement.
2. Save the direct Postgres connection string in the production deployment secret
   store. Keep production credentials out of local `.env` and `.dev.vars` files.
   Turn off Neon's connection-pooling option when retrieving the Hyperdrive origin
   connection. Follow the
   [Neon connection guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/).
3. In the intended Cloudflare account, create the production Hyperdrive
   configuration. Disable query caching before binding it to the Worker.
   Keep credentials out of tracked files and command history.
4. Verify the configuration's origin and `caching.disabled` value in the dashboard
   or with the project-local `wrangler hyperdrive get` command. Record its ID for
   the production binding.

Caching belongs to the Hyperdrive configuration, not the Wrangler binding.
Cloudflare enables it by default. See
[Disable caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/#disable-caching)
for the `--caching-disabled` option when creating or updating configurations.

## Configure the production Workers

Texfolia has two environments: local development and production. Local development
uses loopback Postgres, Docker compiler containers, and local Worker storage.
Production uses Cloudflare Workers, Containers, R2, queues, Durable Objects, and
Neon through Hyperdrive. These environments do not share resources or secrets.

Edit `apps/web/wrangler.jsonc` before building the production deployment artifact.

1. Replace the existing `env.production.hyperdrive` placeholder ID with the
   cache-disabled production configuration. Keep the binding name `HYPERDRIVE`.
2. Add a production `placement` setting with the matching database region.
   For example, use `"placement": { "region": "aws:us-east-1" }` only for a
   database in that region. See
   [Placement hints](https://developers.cloudflare.com/workers/configuration/placement/#configure-explicit-placement-hints).
3. Configure production routes, auth origins, Turnstile keys, OAuth callbacks,
   Stripe settings, email delivery, and Worker secrets in the production account.
   Never copy production secrets into local environment files.
4. Provision the existing production source bucket `texfolia-sources`. Provision
   the compiler's existing bucket, queues, and container infrastructure using the
   [compiler deployment guide](../apps/compiler/README.md#deploy-to-cloudflare).
   The production web service binds `COMPILER` to `texfolia-compiler`.
5. Run `bun run cf:typegen` after changing bindings.

The top-level web configuration is for local emulation. Its local Worker,
source bucket, and compiler service names are distinct from production. Remote
Vite bindings are disabled. Keep `DATABASE_URL` and
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` on loopback hosts.
The local Hyperdrive placeholder is not a cloud configuration ID.

## Migrate, deploy, and verify production

1. Run the full app checks locally before deployment. Verify sign-in, project
   creation, source save and reload, collaboration, compilation, PDF retrieval,
   and template copying against local Postgres and local storage.
2. Run the reviewed, committed migrations from the production deployment context
   with `DATABASE_URL` set to Neon's direct connection. Use `db:migrate`.
   `db:push` accepts only local databases.
3. Run `bun run deploy` after the migration succeeds. Turbo builds the web app
   for `env.production` and deploys `texfolia-compiler` before `texfolia-web`.
   `bun run --cwd apps/web build` explicitly sets `CLOUDFLARE_ENV=production`.
   Inspect the generated Worker name, Hyperdrive ID, source bucket, and compiler
   service before deploying the artifact. Selecting an environment only at deploy
   time does not retarget a Vite build. See
   [Cloudflare Vite environments](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/).
4. Seed the original templates from the production deployment context using the
   production database and source bucket as described in
   [Seed original templates](templates.md#seed-original-templates).
5. Check the deployed production app and inspect Worker logs for database and
   binding errors. Confirm saved writes are visible immediately and Hyperdrive
   query caching remains disabled.

The current deploy scripts do not run database migrations. Complete that launch
workflow before the first production deploy. Account, route, secret provisioning,
and the existing production placeholder values remain launch setup work.
