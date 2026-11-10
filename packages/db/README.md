# Database

The database package owns the Drizzle schema and PostgreSQL client. All commands
below run from the repository root through Turbo.

## Start development

Copy `.env.example` to `.env` in this directory and set `DATABASE_URL`. The
example points to the Postgres service in `compose.yaml`.

```sh
bun run dev
```

Turbo starts Postgres, waits for its health check, applies the schema, and then
starts the web app and compiler. `bun run dev:workers` applies the same database
setup before starting the app with the Workers compiler.

## Apply the schema

```sh
bun run db:push
```

This task starts Postgres if needed and runs `drizzle-kit push` from this
package. The task is uncached because it changes database state. Application
development depends on this task, so a fresh database has its tables before the
web app starts.

## Generate auth tables and check types

```sh
bun run auth:schema
bun run typecheck
```

Auth schema generation runs in the web package and writes
`src/db/auth-schema.ts`. The typecheck task includes this package.
