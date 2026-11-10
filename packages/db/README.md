# Database

The app uses Drizzle and `pg` against PostgreSQL. Workers receive their connection string from the `HYPERDRIVE` binding. Local development uses the same binding with plain Postgres. Application code does not use Neon-specific APIs.

## Run locally

Configure `packages/db/.env` and `apps/web/.env`, start Postgres, and apply the schema as described in the root README. The default database is `db` on `localhost:5432`. Then run `bun run dev` from the repository root. Turbo runs the workspace development tasks; schema setup is an explicit command.

For standalone schema commands, copy `.env.example` to `.env` in this directory and set `DATABASE_URL`. Use a direct Postgres connection string for schema commands, including on Neon. `DATABASE_URL` must be configured; there is no fallback connection string.

```sh
bun run db:push
```

Run this command from the repository root. There are currently no generated migration files or snapshots in the repository.

## Change the schema

1. Edit `src/db/schema.ts`. For auth changes, run `bun run auth:schema` from the repository root.
2. Run `bun run db:push` against your local database.
3. Run the integration check.

The `db:generate` and `db:migrate` commands remain available when reviewed migrations are needed for deployment. Generate those artifacts explicitly before using `db:migrate`.

## Connection lifetime

`createDb` creates a lazy, bounded `pg.Pool`. The request middleware closes it in `finally` after the request handler finishes, including when a handler throws. Do not share a pool across Worker requests or keep it on a Durable Object. Create one inside the operation that needs it and close `db.$client` afterward.

Keep transactions limited to related database operations. Call email, billing, and compiler services outside transactions. Hyperdrive uses transaction pooling, so do not depend on session-level advisory locks, `SET` state across transactions, or a persistent connection identity.

## Verify plain Postgres

Create an isolated database with `test` in its name, apply the schema to it with `DATABASE_URL` set using `bun run db:push`, and run this command from the repository root:

```sh
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run test:integration
```

This check runs the app's database operations against Postgres. It verifies project transactions, collaborator relations, binary text state, constraint rollback, and ownership checks. CI applies the schema to a plain Postgres container and runs this check. It does not initialize auth or substitute API credentials.
