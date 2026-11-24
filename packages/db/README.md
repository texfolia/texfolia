# Database

The app uses Drizzle and `pg` against PostgreSQL. Workers receive their connection string from the `HYPERDRIVE` binding. Local development uses the same binding with plain Postgres. Application code does not use Neon-specific APIs.

## Run locally

Configure `packages/db/.env` and `apps/app/.env` as described in the root README.
The default database is `db` on `localhost:5432`. Run commands in this guide
from the repository root. Start Postgres and apply the schema before the first
app run:

```sh
bun run db:start
bun run db:push
bun run dev
```

`bun run dev` starts Postgres and waits for its health check before starting
the web app. It does not push the schema or seed data. Run `bun run db:push`
explicitly after schema changes. Compose manages only Postgres.

For standalone schema commands, copy `.env.example` to `.env` in this directory and set `DATABASE_URL`. Use a direct Postgres connection string for schema commands, including on Neon. `DATABASE_URL` must be configured; there is no fallback connection string.

```sh
bun run db:push
```

Standalone schema tasks do not start Docker. `db:push` requires a loopback
database URL. Use reviewed migrations from the production deployment context
for Neon.
`bun run db:seed` runs this package's template CLI. It seeds the original templates
in the local database configured in `packages/db/.env` or the shell and the
web app's local R2 bucket. Run it after `db:push`; it does not apply the schema.
See [Template lifecycle](../../apps/docs/src/content/docs/templates.md#seed-original-templates) for
seed behavior and remote seeding.

Local development and CI use `db:push`. No generated migrations or
snapshots are tracked yet. Generate and review the baseline only after the v1
schema settles, immediately before the first production deploy. Production
must use committed migrations. Follow the
[Neon and Hyperdrive deployment guide](../../apps/docs/src/content/docs/database-deployment.md).

## Change the schema

Application tables, including project, template, and AI billing records, are defined in `src/schema.ts`.
Generated Better Auth tables and relations are defined in `src/auth-schema.ts`.
Both are exported through `@texfolia/db/schema`.
NAT-287 adds independent preview state and account-free curated templates.
Apply these schema changes with `bun run db:push`. See
[Template lifecycle](../../apps/docs/src/content/docs/templates.md#schema-setup) for setup instructions
and the Drizzle seed command.

The schema includes a collaboration room registry.
The registry has no foreign key to `project`, so account and organization cascades
cannot erase pending cleanup. The hourly source sweep removes a registration
only after the collaboration object confirms project deletion and purges its state.
New rooms register before writing SQLite state.

The `project_job` table includes a nullable request digest for compilation-ID
retry handling. Jobs created before this change keep a null digest and remain
readable, but their IDs cannot be reused for submissions.

Personal project names are case-sensitive and unique per owner among rows with
`deleted_at IS NULL`. A row with `deleted_at` is in the trash: its name is
released, and the row and everything it owns are retained until it is restored
or the row is deleted. Organization project names keep their existing policy, which
allows duplicates.

1. Edit `src/schema.ts`. For auth changes, run `bun run auth:schema` from the repository root to regenerate `src/auth-schema.ts`.
2. Run `bun run db:push` against your local database.
3. Run the integration check.

The `db:generate` and `db:migrate` commands remain available when reviewed migrations are needed for deployment. Generate those artifacts explicitly before using `db:migrate`.

## Connection lifetime

`createDb` creates a lazy, bounded `pg.Pool`. The request middleware closes it in `finally` after the request handler finishes, including when a handler throws. Do not share a pool across Worker requests or keep it on a Durable Object. Create one inside the operation that needs it and close `db.$client` afterward.

Keep transactions limited to related database operations. Call email, billing, and compiler services outside transactions. Hyperdrive uses transaction pooling, so do not depend on session-level advisory locks, `SET` state across transactions, or a persistent connection identity.

Source storage deliberately uploads immutable R2 objects while holding the
project row lock. This serializes byte quotas, source versions, deletion, and
garbage collection. Metadata commits only after the upload succeeds; the daily
source sweep removes objects left by rolled-back SQL transactions. Replaced and
deleted sources are queued in `source_garbage` for the hourly collection. See
[the web reference](../../apps/app/README.md#project-source-storage) for storage
behavior and verification. For an existing database,
prepare and review an upgrade against its actual schema before deploying.
For a new database at launch, use the baseline described in the deployment guide.

## Verify plain Postgres

Create an isolated database with `test` in its name, apply the schema to it with `DATABASE_URL` set using `bun run db:push`, and run this command from the repository root:

```sh
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run apps/app/test/postgres.ts
```

This check runs the app's database operations against Postgres. It verifies project transactions, collaborator relations, constraint rollback, ownership checks, create/trash/recreate, retained project history, and concurrent duplicate active names. CI applies the schema to a plain Postgres container and runs this check. It does not initialize auth or substitute API credentials.

## Assistant billing records

The Drizzle schema includes per-user settings, run records, and the durable
request ledger. Billing records retain their original payer after account or
project deletion. See
[Configure the managed assistant](../../apps/docs/src/content/docs/ai-assistant.md) for reconciliation
and verification.

## Collaboration persistence

Yjs snapshots and update journals live in `ProjectCollaboration` Durable Object
SQLite. R2 stores merged source text, and Postgres stores source versions and the
cleanup registry. The unused `project_node_text` table and its composite node-kind
constraint are no longer part of the Drizzle schema. No application path reads
or writes that table. Review removal from any existing database alongside the
first-deploy baseline or an explicit upgrade. This cleanup includes no destructive
rollout SQL.
