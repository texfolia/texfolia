# Product app

TanStack Start runs the React workspace and authenticated API on Cloudflare Workers.
Follow the [root setup guide](../../docs/local-development.md) to start the full local stack.
From the repository root, `bun run --cwd apps/app build` builds the product app alone.

## Authentication

OAuth configuration in `.env.example` covers GitHub, Google, GitLab, and Microsoft.
Set credentials for the providers you use. The email sign-in flow uses the local
Cloudflare email binding during development.

See [Public auth abuse protection](../../docs/auth-abuse-protection.md) for the
enabled routes, CAPTCHA policy, rate limits, and verification commands.

## Projects

See [Projects dashboard](../../docs/projects.md) for creation flows, private tags,
client-side table behavior, and verification.

## Public templates

The public gallery lives on the marketing site ([`apps/web`](../web/README.md) at
`/templates`) and loads `GET /api/templates` from this app. Stable snapshots use
`/template/$templateId`, and saved projects can be published at
`/templates/publish`. Reviewers use `/templates/review`. Every snapshot is
reviewed. Preview generation and retries run independently of moderation,
including in local development without cron.

See [Template lifecycle](../../docs/templates.md) for the design, original Drizzle
seeds, schema setup, retention, and verification commands.

## Project source storage

Saved text and binary files live in the web Worker's `SOURCES` R2 bucket, indexed
by `project_node.object_key` and `size_bytes`. Keys are
`projects/{projectId}/sources/{sha256}`. Collaborative text edits persist automatically.
**Save** (Cmd/Ctrl+S) waits for merged text to reach R2, then submits the
acknowledged source snapshot as a cached build while **Compile after saving** is
on (the default). **Save without compiling** (Cmd/Ctrl+K S) only persists,
**Save & compile** (Cmd/Ctrl+Shift+B) always compiles, and **Clean build**
discards the cache. See [keyboard shortcuts](../../docs/settings.md#keyboard-shortcuts).
Uploads use the same storage and quota checks. Text uploads (including `.bib`)
remain editable; binary sources can be downloaded, exported, and compiled.

Source names and full paths follow the [project path policy](../../docs/source-paths.md).
Creation and uploads check the assembled path before storage. Existing invalid
paths appear in the Files sidebar under **Repair source paths**. Renaming keeps
file contents and collaboration documents.

Owners and editor collaborators can write. Viewer collaborators can read and
export. Binary writes compare the previous object key to reject stale overwrites.
Text edits merge through the project's collaboration object.
Limits are 10 MiB per file and 50 MiB per active project, using actual UTF-8 or
binary byte counts. Compilation has its separate 10 MiB JSON payload limit,
including base64 overhead for binary assets.

Postgres and R2 cannot share a distributed transaction. Each write locks the
project row, checks access, version, and aggregate quota, uploads the immutable
object, then commits `object_key`, `size_bytes`, and `updated_at` together in a
Postgres transaction. A failed R2 write leaves metadata unchanged. A failed SQL
commit can leave an unreferenced object, never a committed pointer to an object
that was not uploaded. The same lock serializes node/project deletion and GC.

The web Worker's hourly scheduled handler deletes unreferenced source objects,
including superseded versions, failed-write orphans, deleted descendants, and
deleted projects. Shared hashes are retained while any live node references
them. It uses SQL references, not an age-based bucket lifecycle that could erase
old but still-current files. Source reads also hold the project lock in shared
mode so GC cannot remove a version while it is being read.

On open, sources come from the server. Legacy local-storage drafts are uploaded
automatically only for text nodes without a server object. Other differing drafts
are offered for recovery, download, or discard. Recovery applies a diff to the
shared document. New collaborative edits use the Yjs IndexedDB cache described
below; the legacy text-draft cache is only used for migration.
Before clearing storage in an old browser, open each legacy project there once
and let migration finish.

### Real-time collaboration

The web Worker exports `ProjectCollaboration`, with one SQLite-backed Durable
Object named by `projectId`. Each text file has a Yjs document and a WebSocket.
The workspace keeps those documents connected while file tabs open and close,
so analysis, export, and compile inputs include changes to closed files.
Binary files retain their existing source-storage path.

Open workspaces fetch `/api/projects/:projectId/metadata` after each two-second
refresh interval, on focus, and on reconnect. Each request checks current project
access under the same database lock as source writes. Snapshots contain the file
tree, saved source versions, and write permission. Reconciliation preserves
optimistic writes, Yjs documents, tabs, selections, and offline caches. Deleted
text files leave the tree, but their open panels remain read-only so you can copy
local text. Revoked sessions stop receiving metadata and retain their local drafts.

Compile and export refresh metadata before collecting sources. Export checks the
snapshot again before creating the ZIP and asks you to retry if files changed.
Compile sends saved source hashes and a digest of the tree and saved versions.
The authenticated compile route compares that digest with current database state;
if they differ, it rebuilds the submission from saved R2 sources. This prevents a
stale session from omitting new files or restoring deleted files in the build.

Compile POSTs reserve `X-Compilation-Id` atomically in Postgres. The stored SHA-256
digest covers the authenticated user, project, parsed delta including content,
metadata version, clean-build flag, and editor headers. Matching retries return
202 with the existing status and preview URLs without submitting again. They omit
accepted revisions so the client reconciles through the authenticated GET route,
including after an uncertain compiler response. Reusing an ID with different
inputs, another user, or an older job without a digest returns a generic 409.
Each retry rechecks session and project write access.

Apply the schema with `bun run db:push` locally. For production, follow the
[baseline migration setup](../../docs/database-deployment.md#prepare-the-baseline-at-launch).
Run the route's Postgres regression check with:

```sh
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/app test:compile-route
```

The check runs the production POST and GET handlers with signed sessions,
Postgres, local R2, and the compiler coordinator. Only the TeX engine and a lost
compiler response are fixtures. It covers concurrent and completed retries,
request conflicts, source resync, authorization, and status reconciliation.

`y-codemirror.next` binds the editor, remote selections, and user cursors to Yjs.
Undo affects the local user's edits. Formatting keeps the existing minimal-diff
path. The WebSocket route authenticates the session and checks the request
origin. The object checks current project permissions on every message. Viewer
clients receive changes and publish presence; the server rejects their document
updates. Presence names and colors come from the authenticated session.

The object journals accepted Yjs updates in SQLite before broadcasting. At 64
updates or 256 KiB of journal data per file, it replaces the snapshot and deletes
the journal. Snapshots retain the CRDT identities needed by offline clients.
Encoded Yjs state is capped at 20 MiB, including CRDT metadata; text retains its
10 MiB source limit. Snapshots and updates use 1 MiB SQLite chunks to stay below
the per-row storage limit.
Compaction does not reset the document or discard offline merge history.

An alarm writes merged text to R2 after two seconds, through the same project
lock, quotas, and content-addressed keys as other sources. Failed writes remain
dirty in SQLite and retry. Save waits for this write, and compile uses the
acknowledged merged text. The existing ProjectCoordinator stays in the compiler
Worker and receives source-change notifications through its existing endpoint.

Project and recursive file deletion notify the collaboration object after the SQL
transaction commits. Cleanup removes snapshots, journals, and their chunks,
destroys cached documents, and closes affected sockets. Accepted dirty edits are
discarded when their source is deleted; they cannot recreate the source.
Clean disconnected rooms retain an hourly alarm that checks deletion too.

The hourly source sweep also reconciles rooms in `project_collaboration`, even
when a room has never saved an R2 source. Registrations survive account and
organization cascades. Failed cleanup or SQL acknowledgement leaves the
registration for the next sweep. The registry is part of the Drizzle schema.

WebSockets use the hibernation API. Attachments retain file identity and presence
across eviction. Automatic ping/pong responses do not wake the object. On wake,
the object restores each document from its snapshot and journal. It reconciles
any interrupted source commit before accepting further edits. Pending writes
remain editable if saving failed, including when the project exceeded its quota.

Editors cache Yjs updates in IndexedDB, scoped by user, project, and file. After
the first synchronization, editing can continue offline. Reconnect exchanges
state vectors and merges missing updates in both directions. Reloading the page
also restores cached updates. The first open of an uncached file needs a server
connection. Keep the page open until connected if the browser cannot use
IndexedDB. Viewer clients do not load writable caches.

### Live access revocation

Compile SSE subscriptions and progressive PDF streams check project access
before each outgoing payload. The check holds shared locks on the project and the
recipient's collaborator or membership row through delivery. A committed removal
therefore prevents subsequent build payloads from being sent. Failure to verify
access also closes the subscription.

Collaboration rooms cache each connected user's access in memory, so edits and
cursor updates do not query Postgres. Paths that change access notify the room
through `invalidateAccess`. Sharing changes notify it inside the revoking
transaction. The next delivery to that user then waits on the revocation's locks
and sees the committed change. Organization member removal and leaving notify
every registered room of the organization after Better Auth commits. Project and
file deletion close sockets through source cleanup. Eviction clears the cache.

Idle subscriptions and collaboration rooms recheck access every five seconds.
If a notification fails, this check is the backstop: a revoked user can receive
updates for up to five seconds, plus database time and runtime scheduling.
Collaboration uses a durable alarm so checks continue after hibernation. The alarm
also reconciles open documents with sources saved outside collaboration. Revoked
WebSockets close with code `1008`. Compile streams close and cancel their upstream
reader. Reconnects use the normal authenticated routes and reject removed users.

Personal collaborators downgraded to viewers keep read access, but cannot submit
edits. Organization members keep project access when their organization role
changes. Removing membership revokes that access. Edits accepted before removal
remain in the collaboration journal and still flush to source storage.

### Local development and rollout

The R2 binding in `wrangler.jsonc` uses Wrangler's local simulation during
`bun run dev`. No R2 credentials are required locally, and local bucket data is
stored under `.wrangler/state`. The local bucket is `texfolia-sources-local`.
Production uses `texfolia-sources` under `env.production`. Provision the production
bucket before deploying and enable the configured hourly cron. Vite disables
remote bindings, and local database and compiler URLs must use loopback hosts.

On the first `bun run dev` after the local bucket rename, the startup script
copies existing emulated sources into `texfolia-sources-local`. It preserves the
old local bucket, skips files already in the new bucket, and records completion
under `.wrangler/state/v3`. Later starts do not restore files you have deleted.

Apply the schema change before deploying the Worker. Local `bun run db:push`
updates the constraint that allows text nodes to reference R2 objects.
For a new database at launch, use the reviewed baseline. For an existing database,
prepare and review an upgrade against its actual schema. Follow the
[Neon and Hyperdrive deployment guide](../../docs/database-deployment.md).

Run from the repository root against an isolated, schema-initialized database:

```sh
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run apps/app/test/source-storage.ts
```

This uses the configured R2 binding with isolated temporary local storage and
real Postgres. It tests text/binary round trips, byte counts, authorization,
stale versions, rollback, deduplication, garbage collection, recursive deletion,
and concurrent aggregate quotas. The existing compiler invalidation calls are
best-effort and log failures when the compiler Worker is unavailable in this
standalone check. CI runs this check after applying the database schema.

To check uploads in the rendered workspace, start a local Tectonic engine and run:

```sh
bun run --cwd apps/app playwright install chromium
ENGINE_URL=http://127.0.0.1:8081 bun run --cwd apps/app test:workspace-upload
```

This separate browser check mounts the production workspace, uploads a PNG,
compiles it with Tectonic, and renders the PDF with PDF.js without navigation or
reload. It also checks uploads that have never been opened, rejected upload and
deletion rollback, compile retries, text initialization, and hash-only binary
transport. Authenticated RPCs, source storage, collaboration responses, and build
events use an in-memory network fixture. This check needs no database or R2 and
runs separately from `bun test` and CI.

Run the collaboration integration suite against the same isolated test database:

```sh
bun run --cwd apps/app playwright install chromium
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/app test:collaboration
```

The suite runs the production collaboration object in workerd, with local R2,
SQLite, and real Postgres. Isolated Chromium contexts exercise the production
client and CodeMirror binding. It covers concurrent and offline edits, reconnect
and reload recovery, read-only viewers, permission changes, named cursors,
formatting, local undo, hibernation, snapshot compaction, and persisted sources.
The test entry point invokes the production collaboration and compile GET routes
with signed Better Auth sessions stored in Postgres. A compiler fixture supplies
controlled SSE and progressive PDF chunks. Revocation cases cover personal
collaborators and organization members, including idle sockets after hibernation,
role changes, denied reconnects, viewer access, and persistence of accepted edits.
They also assert that edits and cursor updates run no Postgres queries.
Deletion cases inspect actual SQLite tables, R2 objects, and SQL metadata after
project and recursive file deletion, owner cascades, and retries following SQLite
and Postgres failures. They also check dirty edits, idle clean rooms, chunk
rollback, memory cache removal, socket closure, and deletion during GC.
CI installs Chromium and runs this suite with the database checks. Set
`CHECK_COLLABORATION_LATENCY=1` to include a warm local propagation check against
the 200 ms target. This check times edit dispatch through the receiving
CodeMirror update; it does not measure deployed latency.

## Editor libraries

The editor uses [codemirror-lang-latex](https://github.com/TeXlyre/codemirror-lang-latex) for parsing, highlighting, folding, indentation, environment closing, completion, tooltips, and syntax diagnostics. `@texfolia/editor/latex/language` ([source](../../packages/editor/src/latex/language.ts)) combines its completion source with project labels, citations, file paths, and package commands. A single linter merges syntax diagnostics with project and compiler diagnostics so neither replaces the other.

Syntax linting runs in open editors and reports to the workspace Problems panel. The analysis worker checks references, citations, and missing files across the project. File-local checks for references, bibliography declarations, and package imports are disabled in project editors because those declarations can live in another file. Document-environment checks are disabled to support included fragments.

Editor-owned linting uses the package's public `EditorView` API. Keeping syntax linting in the analysis worker would require a fabricated editor view, so the integration does not use that approach.

[wasm-latex-tools](https://github.com/TeXlyre/wasm-latex-tools) supplies `TexFmt` in the formatting worker. Formatting retains minimal edits, isolated undo, and rejection of results after the source changes. `bun run dev` and `bun run build` copy package assets into the ignored `public/core` directory. Use `bun run latex:assets` to refresh those assets separately. Keep `core/texfmt/tex_fmt.js` and `core/texfmt/tex_fmt_bg.wasm` in deployed static assets; `TexFmt` loads them at runtime.

**Settings > Appearance** previews UIW themes across the app and editor on hover
or keyboard focus. In the editor, Settings opens as a dock panel. Theme selection
edits a draft; Apply saves it, Save saves and closes, and Cancel discards it.
Appearance is saved per account in this browser. Follow system uses GitHub Light
and GitHub Dark. See [Themes](../../docs/themes.md) for storage and migration.

Run `bun run test`, `bun run typecheck`, and `bun run format:check` to check the integration. Completion tests exercise the installed language extension together with project suggestions.

## Personal accounts and organizations

Organization setup follows the [Better Auth organization plugin](https://better-auth.com/docs/plugins/organization)
and [Stripe organization billing](https://better-auth.com/docs/plugins/stripe#using-with-organizations) documentation.
`src/lib/auth.ts` contains the organization configuration and billing authorization.
Auth tables and relations, including organizations, are generated into
`packages/db/src/auth-schema.ts` from the shared auth configuration.

Personal accounts work without an organization. Existing projects remain owned by users,
and selecting an organization does not transfer personal projects or subscriptions.
Use `authClient.organization.setActive({ organizationId: null })` to clear the active organization.

Invitations use the existing email service and link to `/accept-invitation/$invitationId`.
Set `BETTER_AUTH_URL` to the web app's public URL. Recipients must sign in with their
verified invitation email address and explicitly accept the invitation.

Personal billing uses the default `customerType: "user"`. For organization billing,
pass `customerType: "organization"` and the organization's ID as `referenceId` to
`authClient.subscription` methods. Only current owners and admins can access organization billing.
Each organization has its own Stripe customer ID.

Generate the auth schema from the repository root:

```sh
bun run auth:schema
```

The same command is available from `apps/app`. It only generates the TypeScript
schema in `packages/db`; it does not connect to Postgres, apply migrations, or
require service credentials. The CLI version matches the installed Better Auth
version and should be updated with it.

After configuring `packages/db/.env`, apply the schema from the repository root:

```sh
bun run --cwd packages/db db:push
```

## Styling

Use Tailwind classes on components. `src/styles.css` contains imports, font setup,
theme tokens, and the Dockview `@utility` that maps app tokens to library variables.
Keep handwritten selector rules out of the stylesheet. Runtime theme values and
CodeMirror styles use their libraries' APIs. Vendor stylesheets remain imported
by the components that need them.

`bun run check:repo` from the repository root checks this policy and local doc links.
The production asset check verifies generated CSS and copied worker assets.

## Deploy to Cloudflare Workers

Deployment remains deferred until the first production launch. Follow
[Set up Neon and Hyperdrive](../../docs/database-deployment.md) to provision
resources, review and apply migrations, configure secrets, and build for the
intended environment. Use the repository's installed Wrangler version.

Run `bun run deploy` from the repository root to deploy production. Both Worker
deploy scripts pass `--env production`, and the web build selects
`CLOUDFLARE_ENV=production`. Turbo deploys `texfolia-compiler` before the web app.
Production compiler
requests use the `COMPILER` service binding in `wrangler.jsonc` and need no
internal token. `COMPILER_URL` is only a development setting and defaults to
`http://localhost:8080`. See the [compiler deployment guide](../compiler/README.md).
After changing bindings, run `bun run cf:typegen` to refresh their TypeScript types.

Bindings are configured in `wrangler.jsonc`. See
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

## Routing and verification

File-based routes live in `src/routes`. Generate `src/routeTree.gen.ts` with
`bun run --cwd apps/app generate-routes` from the repository root. Auth requests
use `/api/auth/$`; unknown paths use the root route's not-found component.

Run the complete workspace metadata check against an isolated test database:

```sh
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/app test:workspace-metadata
```

This builds and serves the production app in workerd with real Postgres, local R2,
and the collaboration Durable Object. Two Chromium sessions use signed Better
Auth cookies, production loaders, and authenticated RPC and API routes. The check
covers creation, folders, binary uploads and version changes, delayed snapshots,
changes during compilation, stale compile submissions, ZIP contents, editor
selection, offline recovery after reload, and personal and organization access
revocation. A compiler fixture holds jobs open so metadata changes can occur
during a build. CI runs this check after applying the database schema.

## Managed AI assistant

See [Configure the managed assistant](../../docs/ai-assistant.md) for Gateway
credentials, the Stripe usage meter, spend controls, reconciliation, and tests.
