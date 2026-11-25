---
title: Template lifecycle
---

NAT-287 keeps the public gallery, stable snapshot URLs, unlisted sharing, source
ZIPs, licenses, and reviewer reports. Each published snapshot now requires
review. Previous approval of a publisher does not approve their future uploads.
The UI overhaul remains in NAT-286.

The implementation lives in [`#/lib/templates`](../../../../app/src/lib/templates/README.md).
The public gallery stays in `apps/web`. Template routes, server functions, and the
create-from-template UI stay in `apps/app`.

## Storage and ownership

Postgres owns metadata and an immutable source manifest. R2 stores source objects
at `templates/{id}/sources/{sha256}`. Publication checks access and limits, copies
saved project files with no lock held, and checks again before it commits. Browser drafts are excluded. Opening a template copies
its tree and files into independent project objects with new IDs.

Curated starters have a null owner and no organization. User publications have an
authenticated publisher. Account and organization cascades delete their template
rows and reports. Starters survive account deletion. Copied projects follow their
own ownership and retention rules.

Keeping content-addressed R2 sources preserves the existing snapshots and binary
support. Moving all sources into Postgres would make seeds easier, but would also
require a cross-storage backfill and put large binary files in the database.
Curated-only templates would remove moderation, but would also remove user
publishing. This implementation retains user publishing with simpler review.

## Review and previews

Moderation is `pending`, `approved`, or `rejected`. Every new user snapshot starts
pending. Reviewers cannot review their own snapshots. Approval controls public
access, gallery membership, source downloads, and project copies. Unlisted
approved snapshots are accessible by URL and carry `noindex, nofollow`.

Preview state is independently `queued`, `ready`, or `failed`. Review and copying
can proceed without an image. An approved template with a failed preview remains
usable. A reviewer checks the source archive when an image is unavailable.

Each preview attempt has its own build job ID. The detail page subscribes to
`/api/templates/{id}/preview?events=1`, which starts the compile if needed,
follows the temporary project's build stream, promotes the PNG (or records a
failure), and pushes readiness to the client without polling. The minute cron
is a fallback for pages nobody has open. Processing claims a one-minute database
lease before build I/O. Updates compare the job ID and lease so stale
attempts cannot replace newer work. Failed attempts can be retried by the owner
or a reviewer after one minute, without changing the snapshot, URL, moderation,
or publishing allowance. Attempts expire after one hour. Fixing the source still
requires a new snapshot.

Preview compiles use the Pro timeout and a separate usage identity per
snapshot, `template-preview:{templateId}`.
This gives previews a five-minute timeout and a ten-minute rolling hourly budget
without charging the publisher's interactive compile allowance. Separate identities
prevent concurrent starter previews from exhausting a shared reservation budget.
Publication retains the three-per-hour and ten-per-day limits. Retrying an attempt consumes
the same snapshot's preview budget.

Each template compiles in a temporary build project named by its template ID.
The submission names the snapshot's saved objects by key and copies no bytes. The
compiler renders the first page as a stateless artifact, and the build coordinator
stores the build and PNG. After success, the web service
copies the PNG into `templates/{id}/previews/{jobId}.png` and atomically records its
key and ready state. The sources and metadata remain immutable.

## Retention

The hourly web sweep removes objects unreferenced by live template manifests or
preview keys once those objects are at least one hour old. It shares an advisory
lock with publication, seeding, and preview promotion. Account cascades,
organization cascades, removed templates, partial uploads, and superseded preview
objects all use this path.

After the web service records a ready or failed attempt, it deletes the temporary
project. A project whose latest build requested a preview also expires
one day after its last activity, so a failed delete, an abandoned attempt, or a
removed template still leaves nothing behind. Other projects keep their
30-day retention. The permanent template PNG remains available after the
temporary copy is gone.

## Seed original templates

The original CC0 article, generic two-column article, and thesis sources live in
`packages/db/src/template-starters.ts`. They contain no third-party templates or
university or publisher assets. Each snapshot includes `LICENSE.txt`.

The CLI lives in `packages/db/scripts/seed-templates.ts` and calls
[`drizzle-seed`](https://orm.drizzle.team/docs/seed-overview) with explicit values
and deterministic IDs. Each starter is inserted only after its R2 uploads succeed.
Reruns and concurrent runs
skip committed snapshots. Failed transactions can be retried. Seeds create no
user accounts or projects and bypass the user publish API and its limits.

After applying the schema, run from the repository root:

```sh
bun run db:seed
```

Local seeding reads `DATABASE_URL` from `packages/db/.env` or the shell and uses
the web app's default Wrangler R2 persistence in `apps/app/.wrangler/state/v3`.
It also accepts `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` when
`DATABASE_URL` is unset. It does not start Postgres or apply the schema.
To use an isolated R2 directory, run
`bun run --cwd packages/db templates:seed --local --persist-to /absolute/path`.
Start the local compiler with `bun run dev:compiler`, then visit the gallery to
generate previews. No local scheduled event is required.

For a deployed database, set `DATABASE_URL` and `TEMPLATE_SEED_BUCKET` to matching
targets. Configure Wrangler authentication with access to that bucket. Then run:

```sh
bun run --cwd packages/db templates:seed --remote
```

Remote mode uses Wrangler's explicit `--remote` object uploads. The command prints
the stable template routes. It does not deploy Workers or change reviewer access.

## Schema setup

The app is entirely in development. Apply the current Drizzle schema with
`bun run db:push`, then seed the matching database and R2 bucket. No generated
migrations or legacy data backfills are required. Set `TEMPLATE_REVIEWER_IDS`
for the target environment.

## Verification

Use an isolated Postgres database whose name includes `test`. Apply the schema
with `DATABASE_URL` pointed at that database, then run from the repository root:

```sh
DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run db:push
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run packages/db/test/template-seed-cli.ts
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run apps/app/test/templates.ts
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/app test:template-lifecycle
bun test apps/app/src/lib/templates
bun test apps/app/src/lib/builds
ENGINE_URL=http://127.0.0.1:8081 bun run apps/compiler/test/preview.integration.ts
```

The storage suite runs real Postgres and local R2 with a builds fixture. The
browser suite runs the production build and the real build coordinator with a
compiler fixture. It verifies automatic previews without cron, failure, source
access, permissions, and reviewer retries. The final command compiles all three
original starters through a real LaTeX container and checks the PDF and PNG.
