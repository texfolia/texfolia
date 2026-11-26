# @texfolia/db

The Drizzle schema, PostgreSQL client and template seeds. Workers receive their
connection string from the `HYPERDRIVE` binding; local development uses the same
binding against the Postgres container in [`compose.yaml`](../../compose.yaml).
Application code does not use Neon-specific APIs.

```ts
import { createDb } from "@texfolia/db";
import { project } from "@texfolia/db/schema";
```

## Develop

`bun run setup` creates `packages/db/.env`, starts Postgres and applies the
schema. `DATABASE_URL` must point at a loopback database; there is no fallback
connection string. Run these from the repository root:

| Command               | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `bun run db:start`    | Start Postgres and wait for its health check                |
| `bun run db:stop`     | Stop Postgres; data stays in the Compose volume             |
| `bun run db:push`     | Apply `src/schema.ts` to the local database                 |
| `bun run db:seed`     | Seed the original templates into Postgres and local R2      |
| `bun run auth:schema` | Regenerate `src/auth-schema.ts` from the Better Auth config |
| `bun run db:generate` | Generate a reviewed migration for deployment                |
| `bun run db:migrate`  | Apply generated migrations                                  |

`bun run dev` starts Postgres but never pushes the schema or seeds data. Run
`db:push` after every schema change. Local development and CI use `db:push`; no
migrations are tracked until the v1 schema settles. Production must use
committed migrations: see the
[Neon and Hyperdrive deployment guide](../../apps/docs/src/content/docs/database-deployment.md).

## Layout

```text
src/schema.ts         Application tables
src/auth-schema.ts    Generated Better Auth tables and relations
src/index.ts          createDb and the pg pool
src/seed-templates.ts Original templates and the seed logic
scripts/              Template seed CLI
```

See [Architecture](ARCHITECTURE.md) for schema notes, connection lifetime and
the plain Postgres integration check.
