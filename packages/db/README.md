# @texfolia/db

The Drizzle schema and PostgreSQL client. Workers receive their
connection string from the `HYPERDRIVE` binding; local development uses the same
binding against the Postgres container in [`compose.yaml`](../../compose.yaml).
Application code does not use Neon-specific APIs.

```ts
import { createDb } from "@texfolia/db";
import { project } from "@texfolia/db/schema";
// Or import a single feature module directly:
import { projectComment } from "@texfolia/db/schema/comments";
```

## Develop

`bun run setup` creates `packages/db/.env`, starts Postgres and applies the
schema. `DATABASE_URL` must point at a loopback database; there is no fallback
connection string. Run these from the repository root:

| Command               | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `bun run db:start`    | Start Postgres and wait for its health check                |
| `bun run db:stop`     | Stop Postgres; data stays in the Compose volume             |
| `bun run db:push`     | Apply `src/schema/index.ts` to the local database           |
| `bun run auth:schema` | Regenerate `src/auth-schema.ts` from the Better Auth config |
| `bun run db:generate` | Generate a reviewed migration for deployment                |
| `bun run db:migrate`  | Apply generated migrations                                  |

`bun run dev` starts Postgres but never pushes the schema. Run
`db:push` after every schema change. Local development and CI use `db:push`; no
migrations are tracked until the v1 schema settles. Production must use
committed migrations: see the
[Neon and Hyperdrive deployment guide](../../apps/docs/src/content/docs/database-deployment.md).

## Layout

```text
src/schema/index.ts      Barrel re-exporting all tables and cross-feature relations
src/schema/projects.ts   Projects, files, compile jobs, tags, and cleanup tables
src/schema/sharing.ts    Collaborators, teams, share links, share grants, and limits
src/schema/comments.ts   Anchored review comment threads and comments
src/schema/ai.ts         AI settings, chat threads, runs, and billing ledger
src/auth-schema.ts       Generated Better Auth tables and relations
src/index.ts             createDb and the pg pool
```

See [Architecture](ARCHITECTURE.md) for schema notes, connection lifetime and
the plain Postgres integration check.
