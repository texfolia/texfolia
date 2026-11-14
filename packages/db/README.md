# Database

The app uses Drizzle and `pg` against PostgreSQL. Workers receive their connection string from the `HYPERDRIVE` binding. Local development uses the same binding with plain Postgres. Application code does not use Neon-specific APIs.

## Run locally

Configure `packages/db/.env` and `apps/web/.env` as described in the root README.
The default database is `db` on `localhost:5432`. Run `bun run dev`
from the repository root. Turbo starts local Postgres,
waits for its health check, applies the schema, and then starts the web app.
Run commands in this guide from the repository root.

For standalone schema commands, copy `.env.example` to `.env` in this directory and set `DATABASE_URL`. Use a direct Postgres connection string for schema commands, including on Neon. `DATABASE_URL` must be configured; there is no fallback connection string.

```sh
bun run db:push
```

Standalone schema tasks use the configured database without starting Docker.
Local development starts Postgres and applies the schema in its internal setup
task. There are currently no generated migration files or snapshots in the
repository.

## Change the schema

The public-template feature adds `project.organization_id`, template enums,
immutable JSONB snapshots, and reports. Existing deployments must apply
`sql/20261112_templates.sql` once before deploying the templates Worker. The
script runs in a transaction and preserves existing personal projects. Local
development and CI can apply the equivalent Drizzle schema with `db:push`.

Before deploying the collaboration cleanup Worker, apply
`sql/20261113_collaboration_cleanup.sql`. It creates a room registry and backfills
existing projects, including soft-deleted projects with idle collaboration state.
The registry has no foreign key to `project`, so account and organization cascades
cannot erase pending cleanup. The hourly source sweep removes a registration
only after the collaboration object confirms project deletion and purges its state.
The script is safe to run again. New rooms register before writing SQLite state.

1. Edit `src/db/schema.ts`. For auth changes, run `bun run auth:schema` from the repository root.
2. Run `bun run db:push` against your local database.
3. Run the integration check.

The `db:generate` and `db:migrate` commands remain available when reviewed migrations are needed for deployment. Generate those artifacts explicitly before using `db:migrate`.

## Connection lifetime

`createDb` creates a lazy, bounded `pg.Pool`. The request middleware closes it in `finally` after the request handler finishes, including when a handler throws. Do not share a pool across Worker requests or keep it on a Durable Object. Create one inside the operation that needs it and close `db.$client` afterward.

Keep transactions limited to related database operations. Call email, billing, and compiler services outside transactions. Hyperdrive uses transaction pooling, so do not depend on session-level advisory locks, `SET` state across transactions, or a persistent connection identity.

Source storage deliberately uploads immutable R2 objects while holding the
project row lock. This serializes byte quotas, source versions, deletion, and
garbage collection. Metadata commits only after the upload succeeds; the source
sweep removes objects left by rolled-back SQL transactions. See
`apps/web/README.md` for storage behavior and verification. Existing deployments
must apply `sql/20261111_project_sources.sql` before the source-storage Worker.

## Verify plain Postgres

Create an isolated database with `test` in its name, apply the schema to it with `DATABASE_URL` set using `bun run db:push`, and run this command from the repository root:

```sh
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run apps/web/test/postgres.ts
```

This check runs the app's database operations against Postgres. It verifies project transactions, collaborator relations, binary text state, constraint rollback, and ownership checks. CI applies the schema to a plain Postgres container and runs this check. It does not initialize auth or substitute API credentials.
