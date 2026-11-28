# Database architecture

Schema notes, connection rules and verification for `@texfolia/db`. Start with
the [README](README.md) to run the database locally.

## Change the schema

Application tables are split into per-feature TypeScript modules under `src/schema/`, all targeting the default `public` Postgres schema (no `pgSchema` namespaces):

- `src/schema/projects.ts` — `project`, `project_git`, `tag`, `project_tag`, `project_node`, `project_job`, `project_collaboration`, `source_garbage`, and their enums.
- `src/schema/sharing.ts` — `project_collaborator`, `project_share_link`, `project_share_grant`, `project_team`, `sharing_limit`, and `sharing_limit_window`.
- `src/schema/comments.ts` — `project_comment_thread`, `project_comment`, `project_comment_mention`, `project_scratchpad_mention`.
- `src/schema/notifications.ts` — `user_notification` and `notification_kind`.
- `src/schema/ai.ts` — `ai_settings`, `ai_organization_settings`, `ai_thread`, `ai_message`, `ai_run`, `ai_meter_attachment`, `ai_request`, and their enums.
- `src/schema/index.ts` — barrel re-exporting every feature module and `src/auth-schema.ts`, plus cross-feature `defineRelations`.

Generated Better Auth tables and relations stay in `src/auth-schema.ts`.
Everything is exported through `@texfolia/db/schema` (and individual feature modules via `@texfolia/db/schema/<feature>`).
Apply schema changes with `bun run db:push`.

The schema includes a collaboration room registry.
The registry has no foreign key to `project`, so account and organization cascades
cannot erase pending cleanup. The hourly source sweep removes a registration
only after the collaboration object confirms project deletion and purges its state.
`cleanup_requested_at` marks rooms that still hold documents of deleted files; the
sweep leaves all others asleep.
New rooms register before writing SQLite state.

The `project_job` table includes a nullable request digest for compilation-ID
retry handling. Jobs created before this change keep a null digest and remain
readable, but their IDs cannot be reused for submissions.

Personal project names are case-sensitive and unique per owner among rows with
`deleted_at IS NULL`. A row with `deleted_at` is in the trash: its name is
released, and the row and everything it owns are retained until it is restored
or the row is deleted. Organization project names keep their existing policy, which
allows duplicates.

Steps:

1. Edit the relevant feature module in `src/schema/` (and `src/schema/index.ts` if adding cross-feature relations). For auth changes, run `bun run auth:schema` from the repository root to regenerate `src/auth-schema.ts`, then restore the indexes that the generator does not know: `bun test packages/db/src` names them. It also requires an index for every foreign key.
2. Run `bun run db:push` against your local database.
3. Run the integration check.

The `db:generate` and `db:migrate` commands remain available when reviewed migrations are needed for deployment. Generate those artifacts explicitly before using `db:migrate`.

## Connection lifetime

`createDb` creates a lazy, bounded `pg.Pool`. The request middleware closes it in `finally` after the request handler finishes, including when a handler throws. Do not share a pool across Worker requests or keep it on a Durable Object. Create one inside the operation that needs it and close `db.$client` afterward.

Keep transactions limited to related database operations. Call email, billing, and compiler services outside transactions. Hyperdrive uses transaction pooling, so do not depend on session-level advisory locks, `SET` state across transactions, or a persistent connection identity.

No transaction stays open during R2, Durable Object, or other network calls. Source
storage uploads immutable objects to unique per-upload keys first and then commits
under the project row lock, which serializes byte quotas, source versions, and
deletion. A rolled-back SQL transaction deletes its uploaded keys immediately.
Replaced and deleted sources are queued in `source_garbage` for the hourly
collection, which deletes unreferenced objects directly without project locks or
two-phase claims. See
[the product app architecture](../../apps/app/ARCHITECTURE.md#project-source-storage) for storage
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
