# Compiler

## Supported engines

The compiler currently runs only patched Tectonic. TeX Live and latexmk are not
installed, and the app has no engine picker. Telemetry reports `tectonic` or
`unknown`; older records that say `texlive` parse as `unknown`.

See the [multiple compile engine plan](../docs/src/content/docs/compile-engines.md) for NAT-316's
proposed backend contracts, image options, and unresolved product decisions.

## Template previews

Template previews are ordinary project builds. The web service compiles each
template in a temporary project named by the template ID. It sends a
full-snapshot `POST /projects/<templateId>/compile` with `preview: true`
alongside `mainFile` and `files`. Each attempt uses its own compilation ID,
the Pro plan, and the separate usage identity `template-preview:<templateId>`.
Previews do not draw on the publisher's interactive compile allowance.
Retries, the overflow queue, and the DLQ behave as they do for any other
revision. Normal project compilations do not render previews.

After `GET /projects/<templateId>/jobs/<id>` reports success,
`GET /projects/<templateId>/compilations/<id>.png` returns the first-page image.
The PDF and build files remain available through the usual project endpoints.
The web service copies the PNG into permanent template storage. It then calls
`DELETE /projects/<templateId>/build`, after promotion or a terminal failure.
A project whose latest submission requested a preview is temporary.
Maintenance removes its state and objects one day after last activity, so a
failed cleanup still expires. Other projects keep the 30-day retention. Pruning
after each build skips preview images. See [Template lifecycle](../docs/src/content/docs/templates.md)
for publication, retry, permanent image storage, and deletion behavior.

The compile image installs `poppler-utils`. After an opted-in compile, the engine
runs `pdftoppm` with a 15-second cancellation-aware timeout, first-page-only,
1200-pixel maximum dimension, and a 4 MiB output limit. The PNG is passed through
the multipart engine response. The engine client rejects a preview build without
it as an infrastructure failure, which takes the normal retry path. The PNG is
stored when the build publishes. Local SQLite and production R2 use the same
coordinator path. Rebuild the engine image before using this feature in an
existing local stack.

Run `ENGINE_URL=http://127.0.0.1:8081 bun run apps/compiler/test/template-preview.integration.ts`
from the repository root to compile the original article, journal, and thesis
starters with a real container and check both persisted artifacts. Start a
standalone engine on that port first, as shown in [Run locally](#run-locally).
Go's `TestRenderPreview` also runs against real Poppler when it is installed.

## Project builds

Each project has one coordinator. Builds lease Tectonic containers from a shared
pool for one engine attempt. The
coordinator serializes builds, waits 300 ms after the latest source update, cancels
superseded work, and publishes revision metadata over server-sent events.

`ProjectCoordinatorCore` owns these transitions in both runtimes. Workers use a
SQLite-backed `ProjectCoordinator` Durable Object named by project ID, with R2
for artifacts and alarms for debounce and crash recovery. Bun uses SQLite and
persisted alarm deadlines. Both adapters call the same Go engine image.

The normal path calls a leased container directly. Workers enqueue infrastructure
failures for recovery. After consuming the complete result, the pool cancels any
remaining work, wipes project sources, build files, cache, and temporary files,
and returns the process for another project. Projects hold no container between
builds. A healthy spare serves the next job when available. Otherwise the pool
allocates a cold container. After 10 minutes with no compiles and no open
editor, the pool stops every container and runs none until the next compile.
Each attempt restores its project's archive onto its
leased container. See [Container pool](docs/container-pool.md).

## Run locally

From the repository root, configure the environment files described in the
[root setup guide](../docs/src/content/docs/local-development.md), start Docker, and run:

```sh
bun run dev:compiler
```

Turbo builds `texfolia-latex-engine:local` and starts the Hono compiler as a local
Bun process at `http://localhost:8080`. Bun restarts the process when compiler
source changes. This command does not start Postgres or change the database.
`bun run dev` starts both apps and Postgres. Apply the schema explicitly with
`bun run db:push` before the first web app run and after schema changes.

The API uses `/var/run/docker.sock` to create shared containers named
`texfolia-spare-<uuid>` or `texfolia-pooled-<uuid>`. Each container publishes its
engine port on a random loopback port. Set `DOCKER_SOCKET` if your Docker host
uses a different socket path. The socket requires a trusted Docker host.
Compiler source objects, pending manifests, revisions, and PDFs persist in
`apps/compiler/.cache/compiler.sqlite`. `COMPILER_DB_PATH` overrides this path.
Pool inventory and leases persist in `<COMPILER_DB_PATH>.pool.sqlite` and survive
API restarts. Local maintenance checks the pool every minute.

`bun run build` builds the engine image and web app through Turbo.
`bunx turbo run build --filter=compiler` builds only the engine image.
`ENGINE_IMAGE` overrides the image used for project engines. The build command
tags the default `texfolia-latex-engine:local` image.

Template previews and project builds use the shared pool. Only the standalone
verification scripts and integration tests use `ENGINE_URL`, which defaults to
`http://127.0.0.1:8081`. After building the engine image, start a standalone
engine for them in a separate terminal:

```sh
docker run --rm --name texfolia-snapshot-engine --platform linux/amd64 -p 127.0.0.1:8081:8080 texfolia-latex-engine:local
```

Ctrl+C stops the local compiler process. Shared containers remain available for
the next API process. Compose manages only Postgres, so `docker compose stop`
does not stop compiler containers. Remove a compiler container with
`docker rm -f <container-name>` when you need to replace its image.

If you used the previous Compose setup, run `docker compose down --remove-orphans`
to stop its compiler and engine services. When upgrading from dedicated project
containers, remove them with `docker rm -f texfolia-project-<projectId>`.
The shared pool creates new names and does not adopt those containers. The local process uses its own SQLite file instead of the old
`compiler-data` volume. To retain that compiler state, copy `compiler.sqlite`
from the stopped volume into `apps/compiler/.cache/` before starting the API.

## API reference

Call the compiler from a trusted backend. In production, the web Worker uses the
`COMPILER` [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
to call the private `texfolia-compiler` Worker. The compiler has no public routes,
`workers.dev` URL, or preview URLs. The web app checks project
membership before returning builds or files. Owners and editor collaborators can
compile and report edits. Viewer collaborators have read access.

`GET /health` checks whether the API is ready to accept requests.

`POST /projects/<projectId>/compile` accepts `application/json`:

```json
{
  "mainFile": "main.tex",
  "baseRevision": 7,
  "revision": 8,
  "files": {
    "sections/hello.tex": {
      "hash": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "content": "hello"
    }
  },
  "deleted": []
}
```

`mainFile` is required for deltas. File paths are relative to the project root.
Changed entries contain a SHA-256 hash and optional `content` (text or
`{ "base64": "..." }`). Unchanged paths are omitted. A hash-only entry must
already exist in the project's durable source store, or a resync is required.
Full-snapshot requests remain supported; they default to `main.tex`. Template
previews use them, and the interactive editor does not.

A successful submission returns `202 Accepted` with `id`, `status`, and
`statusUrl`, and `sourceRevision` for delta requests. To retry the
same submission, send the same sources and UUID in `X-Compilation-Id`. Reusing
the UUID with different sources returns `409 Conflict`.

Editors send a stable `X-Editor-Id` UUID and increasing `X-Editor-Sequence` with
deltas. The coordinator persists that sequence and rejects delayed older
requests with `409`, including after a restart. The server revision is shared
across editors; the editor sequence only orders requests from one session.

`GET /projects/<projectId>/jobs/<id>` returns a status of `queued`, `running`, `succeeded`, or
`failed`. Wait at least one second between polls. A successful job includes
`log`, `sizeBytes`, and `artifactUrl`. A failed job includes `error`, `log`,
and diagnostics. Invalid LaTeX and timeouts are terminal failures.

`GET /projects/<projectId>/compilations/<id>.pdf` returns the PDF after the job succeeds. The
artifact URL is relative to the compiler and uses the same private connection as
the job URL. The browser retrieves both through the web app's authenticated API.

`GET /projects/<projectId>/jobs/<id>/pdf` waits for the engine's first multipart
part and streams that PDF without waiting for the log, remaining artifacts, or
storage. The web submission response includes an authenticated `previewUrl` for
this stream. The browser renders it while SSE continues to track publication.
Disconnecting the preview does not cancel the persistence branch.

The engine flushes the PDF first, then the log, then the other artifacts. Hono
tees the multipart body: one branch extracts only the PDF; the background branch
parses and saves the complete build under an immutable generation. Only after
every artifact and the job result are saved does the coordinator publish `out/`
and `latestBuild`. A save failure keeps the previous manifest and successful
build; the requesting editor retains its streamed PDF with a “not saved” label.
This transient preview is not durable across coordinator restarts.

`GET /projects/<projectId>` returns `revision`, `current`, `latestBuild`,
`artifacts`, and `stale`. `current` describes the newest compile attempt.
`latestBuild` describes the last successful compile. `artifacts` lists the shared
`out/` files, their sizes, and their generation keys, with the build author,
completion time, engine, and source digest.

`GET /projects/<projectId>/build/files?path=<relative-path>` streams one generated
file. An optional `version` must match that file's generation key. A replaced
version returns `404`, so a download cannot silently mix build generations.
The authenticated browser URL is `/api/compile/<projectId>?file=<path>&version=<key>`.

`POST /projects/<projectId>/changed` accepts `{ "editorId": "<uuid>", "sequence": 1 }`.
It marks the build stale without compiling. Delayed notifications at or below an
editor's accepted sequence have no effect. Edits during a compile leave that
result stale. A successful compile for the current revision clears the indicator.

### Artifact storage and cache

The coordinator writes every generated file under an immutable generation in
`projects/<projectId>/builds/`. It publishes the manifest only after every write
succeeds. A delayed background task then deletes unreferenced generations and older PDFs. Job status
records remain available, but their older artifact URLs return `404`.

A failed compile replaces only its generated `.log`, while the last successful
PDF and other outputs remain available. The diagnostic summary is bounded, but
the generated `.log` keeps its full contents within the build output limit.
Source quotas, source history, and file creation use the project file table;
build files use the compiler object store and never enter that table.

Each successful project build also replaces `projects/<projectId>/cache.tar.zst`
with one zstd-compressed tar archive of generated files other than the main PDF.
This disposable cache is separate from the immutable download generations.
For each lease, the engine client fetches that project's archive and uploads it
to the private `PUT /cache` endpoint. Source downloads run concurrently with
archive fetch and unpack after container readiness. The engine clears the
in-memory project cache when the lease ends. Its process and baked LaTeX formats
remain warm for the next project.
Missing, corrupt, or unavailable archives fall back to an uncached compile.
Older projects without an archive acquire one after their next successful build.

Tectonic reads auxiliaries beside
its primary input, so the engine restores those files there and under `out/`.
Real source paths take priority. Sources can reference generated files through
`\input{out/generated.tex}`. The engine keeps all intermediate files and SyncTeX.

`X-Clean-Build: 1` bypasses and invalidates the saved cache. A failed cached TeX
run retries once without cache. The cache is also bypassed when its recorded
engine differs from the configured Tectonic engine. The app currently supports
only Tectonic. A successful build makes its new cache available for reuse.

The file tree exposes generated files through a separate read-only viewer.
Generated text supports search, and all files support download. **Export project**
excludes `out/` unless **Include generated out/ files** is checked.

A delayed `background` message removes all project artifacts and job objects
30 days after the last source notification or build. Retention messages use
at most daily delay hops until their persisted deadline. A coordinator alarm
re-enqueues overdue maintenance if background delivery exhausts its retries;
the alarm itself never runs a sweep. Sweeps skip
active compiles, stop when a new revision arrives, and only inspect objects
older than the sweep. Sweeps do not hold the coordinator's compile/source writer
during R2 I/O. A delta that reuses the exact obsolete source hash being deleted
waits for that deletion before reading or recreating the object; unrelated
submissions do not wait for cleanup.
The web backend also calls
`DELETE /projects/<projectId>/build` when a project is deleted. If immediate
cleanup fails, background retention still removes the objects. Local SQLite uses
the same durable message policy with independent queue lanes.

`GET /projects/<projectId>/events` streams the same snapshot on attach and after
every transition. It sends heartbeat comments every 15 seconds. EventSource
reconnects with the current snapshot, so no replay cursor is needed. The editor
attaches when the project opens. The stream reports editor presence to the
shared pool on attach and every minute while it stays open. Presence keeps an
existing warm spare from scaling to zero but does not start a container, delay
the first SSE snapshot, or reserve capacity. Cache restore starts after a
compile claims a lease. Presence report failures do not break SSE.
No container snapshots are used. See [Container pool](docs/container-pool.md).
The local [cold-start measurements](cold-start-measurements.md) describe the
previous dedicated-container model.

**Save & compile** saves sources to the web
Worker's R2 bucket, then POSTs a revisioned delta. Save and Cmd/Ctrl+S run it
by default (Settings → Editor → **Compile after saving**); **Save without
compiling** persists only. Typing marks the
preview stale and leaves the saved build running. Browser storage is only an unsaved/offline draft cache;
opening a project reads saved sources from the server, with explicit recovery
for conflicting browser drafts. The interactive request is
`{ mainFile, baseRevision, revision, files: { path: { hash, content? } }, deleted }`.
Only changed paths are included; changed text includes its content, while binary
assets reference their saved SHA-256 hash and are never fetched or uploaded by
the browser's compile action. Source revisions are separate from build revisions
and typing notifications. Acceptance returns `sourceRevision`; results still use
the existing SSE stream, not a WebSocket.

The coordinator keeps a source manifest and content-addressed objects at
`projects/<id>/source-objects/<sha256>` in its R2 store (SQLite locally).
This compiler-side mirror lets alarms, retries, and container restarts recover
without a browser or a request back to the web Worker. Each changed object is
written once; pending builds persist only hashes, encodings, and sizes, never a
full source snapshot. Unreferenced mirror objects are pruned after publication.
The web Worker's source bucket and file table remain authoritative.

A missing coordinator manifest, unknown hash, or mismatched source revision
returns `409 { resync: true, sourceRevision }`. The web Worker reads the saved
project under its source-storage lock and retries once with a full resync; it
does not ask the browser to upload a snapshot. Concurrent conflicts return an
explicit failure rather than leaving a queued job waiting indefinitely.

Each pooled lease starts with a full source resync from the coordinator's durable
mirror. The engine verifies source hashes and hard-links its working copy into
the isolated build directory. It removes that working copy at release.
Delta requests between the browser, web Worker, and coordinator remain unchanged.
The engine also supports deltas within a lease. A missing working copy or disk
hash mismatch returns `X-Source-Resync: 1`, and the engine client retries once
with a full resync using the same job ID.

New revisions terminate superseded jobs with `status: "failed"` and an explicit
superseded error. Cancellation waits for the Go engine to stop the old TeX
process. Late responses cannot publish a build for an older revision. The
coordinator keeps one pending source manifest, replacing it on each submission.

The compiler has no top-level `/compile`, `/jobs/<id>`, or `/compilations/<id>`
endpoints. Every build, including template previews, goes through a project
coordinator.

Limits: 10 MiB of source JSON, 200 source files, a 20 MiB PDF, and 32 MiB of
generated files per build. TeX runs have a 15-second timeout for Free and a
300-second timeout for Pro and Team, reduced when the user has less fair-use
allowance remaining. Cache archives are bounded
to 33 MiB compressed, 32 MiB of file contents, and 1,024 regular files. Restore
rejects traversal, links, duplicate paths, conflicting paths, and invalid zstd
frames before using any contents. The engine accepts up to
64 MiB of internal JSON to carry resync sources and the restored cache. The
coordinator also permits 64 MiB for internal resync JSON; decoded delta projects
retain the 10 MiB source limit even when each individual delta is small.
Both submission APIs require a user identity. Free and unknown plans allow two
submissions per 10 seconds per user, enforced per Cloudflare location or local
process. Pro and Team bypass this short-window limiter. All plans use durable
per-user rolling one-hour fair-use accounting: 180 seconds of compile time for
Free and 600 seconds for Pro and Team. Attempts reserve their allowed runtime
before starting and reconcile actual usage afterward, including failed and
canceled work. Rejections return `429` with `Retry-After`. Polls and downloads do
not count as submissions. The policy is defined in [limits.ts](src/limits.ts).

## Deploy to Cloudflare

The default `wrangler.jsonc` configuration uses `texfolia-compiler-local`, the
`texfolia-compilations-local` bucket, and the `compile-pro-local`,
`compile-free-local`, `compile-dlq-local`, and `background-local` queues.
R2 and queue producers have `remote: false` for local Wrangler development.
The local rate limiter uses a separate namespace. The web Worker's default
`COMPILER` service binding points to `texfolia-compiler-local`.

`env.production` selects the existing `texfolia-compiler` Worker,
`texfolia-compilations` bucket, and queues without the `-local` suffix.
Production repeats the Containers, Durable Object, R2, queue, and rate-limit
bindings because Wrangler does not inherit them across environments. The
production container application name is pinned to
`texfolia-compiler-tectoniccontainer` to preserve its existing identity. Both
configurations keep the compiler private, with no public routes or preview URLs.

Normal local development still uses the Bun runtime, Docker engine containers,
and local SQLite storage described above. Its queues, coordinator state, and
artifacts do not use Cloudflare resources. Local startup rejects non-loopback
database and engine URLs. Keep production secrets out of local environment files.

Use a Workers Paid account with Containers enabled. Run `bun install` from
the repository root. With Docker running, create the required resources from `apps/compiler`:

```sh
bunx wrangler login
bunx wrangler r2 bucket create texfolia-compilations
bunx wrangler queues create compile-pro
bunx wrangler queues create compile-free
bunx wrangler queues create compile-dlq
bunx wrangler queues create background
```

To deploy production, run from the repository root:

```sh
bun run deploy
```

`bun run deploy` is the production deployment command for both Workers. Both
app deploy scripts pass `--env production`; the web build also sets
`CLOUDFLARE_ENV=production` before Vite generates its deployment configuration.
To deploy only the compiler, run `bun run --cwd apps/compiler deploy`.
For a compiler packaging check without uploading, run
`bun run --cwd apps/compiler deploy --dry-run`. Direct `bunx wrangler deploy`
without an environment targets the local resource names instead.

Reuse the bucket and queues if they already exist. When upgrading from
`texfolia-compile`, stop new submissions and drain its backlog with the old
consumer before deploying the replacement configuration. Do not delete a queue
that still contains pending jobs. Turbo builds the web app and deploys the compiler before the web app. The web app's Wrangler configuration binds `COMPILER` to
`texfolia-compiler`; production does not use `COMPILER_URL` or an internal token.
The Worker calls the container through its private Durable Object binding.

The configuration allows up to 20 active containers, including spares. Each
engine attempt claims an exclusive PoolManager lease and releases it after the
result is read. Pool RPC failures fall back to a unique cold allocation, which
the client destroys after the attempt. An
alarm retains the newest pending
snapshot during capacity shortages. The interactive hot path never enters a
queue. After a direct infrastructure failure, the coordinator hands its revision
to `compile-pro` for `X-Compile-Plan: pro`, or `compile-free` for Free, unknown,
or missing plans. Pro and Free consumers have concurrency limits of 4 and 1,
respectively, and process one message per batch. A queued compile gets one
delivery and one retry, then moves to `compile-dlq`; alarms do not independently
retry a handed-off revision. TeX input errors fail directly, without a queue retry.

Compile messages contain only `{ projectId, revision }`. Revisions start at 1.
Consumers log and acknowledge any other message, including revision 0 messages
left by the retired snapshot job system. Source snapshots stay in coordinator
storage or R2.
A stale queue or DLQ delivery cannot change
a newer build. The DLQ consumer logs `Compile dead-letter message` with the
project/job UUID, revision, and failure reason, then persists a terminal failure
and notifies the editor through the normal coordinator event stream. It never
runs TeX. Inspect these structured events in Workers Logs or with
`bunx wrangler tail --env production --format json`; the active DLQ consumer acknowledges a
message only after the failure is recorded, so acknowledged messages are no
longer in the queue.

The separate `background` consumer batches up to 20 messages with concurrency 1.
It carries only coordinator maintenance. The compiler has no scheduled event and
nothing wakes the container pool on a timer, so an idle deployment keeps no
compiler containers.
The `v2` migration adds the coordinator without replacing existing
container identities.

The engine's private HTTP interface provides `GET /health` for readiness,
boot identity, process boot duration, cache readiness, and baked image filesystem
size. `PUT /lease` binds the process to a project for one attempt. Pooled
requests carry `X-Container-Lease` with an increasing generation and a unique
claim ID. `PUT /cache` restores that project's archive within the lease.
Repeated restores on a ready lease are no-ops. `POST /compile` accepts the
same project JSON as Hono. A successful
engine response is multipart form data with an `application/pdf` file named
`pdf`, a text field named `log`, a zstd file named `cache`, and binary fields named `artifact:<path>` for
all other generated files. Failures return JSON with `error`, `log`, and the
full generated log in `logFile` when available.
`DELETE /compilations/<id>` cancels that run and responds after it exits.
`DELETE /lease` cancels active work, waits for it to exit, removes the lease
workdir, and clears project state. Stale lease tokens and requests for another
project return `409`. Overlapping compiles return `503` with `Retry-After: 1`.
Standalone engines used by verification scripts retain their first-project
binding until restart. The engine has no job API or persistent job data. Its image warms the
base LaTeX format during build and runs as uid 10001. Tectonic keeps both
`--untrusted` and `TECTONIC_UNTRUSTED_MODE=1`. Each invocation gets a temporary
directory inside its build workdir.

## Verify the compiler

Run checks from the repository root. Go 1.26 or later is
required for the engine tests, vet, and formatting checks.

```sh
bun run typecheck
bun run test
bun run lint
bun run format:check
```

To run only the compiler's tests, including the Go race tests:

```sh
bunx turbo run test --filter=compiler
```

`coordinator.test.ts` verifies
late-response rejection, serialization, independent engines, idempotency,
request ordering, and SQLite restart recovery.

`source-sync.test.ts` verifies delta transfer, binary references, duplicate job
IDs, composed debounced edits, source-only object persistence, and recovery
across coordinator/container restarts. Go sync tests exercise real HTTP compiles,
deletion, immutable binary reuse, hash failures, and cross-project rejection.
To verify against real Tectonic in an isolated, automatically cleaned container:

```sh
docker build --platform linux/amd64 -t texfolia-latex-engine:local -f apps/compiler/Dockerfile .
bun apps/compiler/scripts/verify-source-sync.ts
```

The check generates PDFs through the SQLite coordinator, verifies changed-only
engine requests, restarts its container, corrupts its working copy, and requires
both cases to recover through a full resync. `ENGINE_IMAGE` overrides the image.

`builds.test.ts` checks full artifact retention, cache restoration, clean retry,
source invalidation, atomic publication through a storage failure, and expiry.
`project-engine.test.ts` checks archive preparation, concurrent source download,
missing or corrupt archives, startup failure recovery, and atomic publication.
`pool.test.ts` checks SQLite recovery, exclusive leases, cleanup before reuse,
expiry, inventory bounds, and the existing arbitration policy.
`pooled-engine.test.ts` checks alternating projects, archive selection, clean
bypass, and retaining the lease through the response tail. Go lease tests check
project state removal, stale tokens, cancellation, and warm process reuse.
Go process tests require both untrusted-mode settings on every compile.

To verify shared containers with real Tectonic and automatic cleanup:

```sh
docker build --platform linux/amd64 -t texfolia-latex-engine:local -f apps/compiler/Dockerfile .
bun apps/compiler/scripts/verify-pooled-engine.ts
```

The check alternates projects on one process, restores each project's cache,
checks for leftover workdirs, restarts the pool adapter, and verifies clean builds.
`ENGINE_IMAGE` overrides the image.

`compile_engine_request` and `compile_backend` include `containerStartMs`,
`containerBootId`, `bootMs`, `imageSizeBytes`, `archiveFetchMs`, `archiveUnpackMs`,
`archiveBytes`, `archiveStatus`, and `prewarmed`. Optional fields keep old timing
records readable. Pooled attempts measure preparation during the job and report
`prewarmed: false`. Use `compile_pool_claim` outcomes to identify shared spare
hits. Historical dedicated-engine measurements attach prewarm timing to the
first compile on the same boot. Detailed field definitions and local measurements are in
[cold-start measurements](cold-start-measurements.md).

`streaming.test.ts` holds back the engine response tail and verifies that the
complete PDF reaches the Hono client first. SQLite faults on artifact and result
writes verify that neither failure publishes the new generation. The parser
tests include byte-by-byte chunks, binary content, false boundary prefixes, and
truncated responses.

`firstPdfByteMs` records engine-request-to-first-PDF-byte in engine/backend events
and compile-action-to-first-PDF-byte in browser preview events. The browser
records this for both streamed and persisted downloads; the percentile script
includes it and omits missing values from older events. Compare like-for-like
warm project cohorts before and after deployment; the gated tests prove ordering,
not a production latency improvement.
Browser render timings are captured immediately but sent after the terminal
status is reconciled, so reports retain the engine, plan, and temperature cohort
even when the preview renders before persistence or saving fails.

To verify real Tectonic output, point the scripts at an isolated engine:

```sh
ENGINE_URL=http://localhost:8081 bun apps/compiler/scripts/verify-build-output.ts
ENGINE_URL=http://localhost:8081 bun apps/compiler/scripts/build-cache.ts
WITH_BIBLIOGRAPHY=1 ENGINE_URL=http://localhost:8081 bun apps/compiler/scripts/build-cache.ts
```

The cache script alternates clean and cached runs, excludes one warm-up pair,
and records five pairs by default. `RESULT_DIR` selects the output directory.
`compile_backend` events include `cacheUsed`, `cleanRetried`, and
`weightedCompileSeconds`. With the current single Tectonic engine, the weight
is one. Both attempts count when a cached compile retries clean.

See [cache measurements](cache-measurements.md) for results and limits.
