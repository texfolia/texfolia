# Compiler

Each project has one coordinator and one dedicated Tectonic container. The
coordinator serializes builds, waits 300 ms after the latest snapshot, cancels
superseded work, and publishes revision metadata over server-sent events.

`ProjectCoordinatorCore` owns these transitions in both runtimes. Workers use a
SQLite-backed `ProjectCoordinator` Durable Object named by project ID, with R2
for artifacts and alarms for debounce and crash recovery. Bun uses SQLite and
persisted alarm deadlines. Both adapters call the same Go engine image.

The normal path calls the project's warm container directly. Workers enqueue
infrastructure failures for recovery. A container never serves another project.
Workers stop idle containers after ten minutes and recreate them under the same
project identity when needed. Local Docker containers keep their project names
across API restarts.

## Run locally

From the repository root, configure the environment files described in the
[root setup guide](../../README.md#local-development), start Docker, and run:

```sh
bun run dev
```

Turbo builds `texfolia-latex-engine:local` and the compiler API image, starts
Postgres and the compiler, waits for health checks, applies the schema, and then
starts the web app. The compiler listens at `http://localhost:8080`. Docker
Compose reloads its Bun process when the compiler source changes.

Ctrl+C stops the development processes. To stop any remaining Compose services,
run `docker compose stop` from the repository root. You can select the web
package with `bunx turbo run dev --filter=web`; the compiler companion still starts.

Compose mounts the Docker socket into the compiler API. The API creates
containers named `texfolia-project-<projectId>` on the Compose network. The
socket requires a trusted Docker host. Local project containers keep their
project names across API restarts and retain their image until removed.
The `compiler-data` volume keeps pending snapshots, revision metadata, and PDFs.

`bun run build` builds both compiler images and the web app through Turbo.
`bunx turbo run build --filter=compiler` builds only the compiler images.
The private `latex-engine` Compose service serves legacy `/compile` jobs.

Project containers remain assigned until removed with
`docker rm -f texfolia-project-<projectId>`. Stopping Compose does not remove
containers created by the API.

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
  "files": {
    "main.tex": "\\documentclass{article}\\begin{document}\\input{sections/hello}\\end{document}",
    "sections/hello.tex": "Hello from Texfolia!"
  }
}
```

`mainFile` defaults to `main.tex`. File paths are relative to the project root.
Text files are strings. Binary assets use `{ "base64": "..." }`.

A successful submission returns `202 Accepted` with `id`, `status`, and
`statusUrl`. The `Location` header also contains the status URL. To retry the
same submission, send the same sources and UUID in `X-Compilation-Id`. Reusing
the UUID with different sources returns `409 Conflict`.

Editors send a stable `X-Editor-Id` UUID and increasing `X-Editor-Sequence` with
snapshots. The coordinator persists that sequence and rejects delayed older
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
succeeds. It then deletes unreferenced generations and older PDFs. Job status
records remain available, but their older artifact URLs return `404`.

A failed compile replaces only its generated `.log`, while the last successful
PDF and other outputs remain available. The diagnostic summary is bounded, but
the generated `.log` keeps its full contents within the build output limit.
Source quotas, source history, and file creation use the project file table;
build files use the compiler object store and never enter that table.

Each compile restores the full latest cache. Tectonic reads auxiliaries beside
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

A persisted coordinator alarm removes all project artifacts and job objects
30 days after the last source notification or build. The web backend also calls
`DELETE /projects/<projectId>/build` when a project is deleted. If immediate
cleanup fails, the retention alarm still removes the objects. Local SQLite uses
the same policy, with long alarms checked in daily intervals.

`GET /projects/<projectId>/events` streams the same snapshot on attach and after
every transition. It sends heartbeat comments every 15 seconds. EventSource
reconnects with the current snapshot, so no replay cursor is needed. The editor
attaches when the project opens. **Save & compile** saves sources to the web
Worker's R2 bucket, then submits a full acknowledged source snapshot. Save and
Cmd/Ctrl+S persist without compiling. Typing marks the preview stale and leaves
the saved build running. Browser storage is only an unsaved/offline draft cache;
opening a project reads saved sources from the server, with explicit recovery
for conflicting browser drafts. Binary assets use base64 entries in compiler
snapshots. Live source collaboration and delta sync are separate work.

New revisions terminate superseded jobs with `status: "failed"` and an explicit
superseded error. Cancellation waits for the Go engine to stop the old TeX
process. Late responses cannot publish a build for an older revision. The
coordinator keeps one pending snapshot, replacing it on each submission.

The legacy `/compile`, `/jobs/<id>`, and `/compilations/<id>.pdf` endpoints remain
available for existing jobs. They retain their queue and rate limit.

Limits: 10 MiB of source JSON, 200 source files, 60 seconds per TeX run,
a 20 MiB PDF, and 32 MiB of generated files per build. The engine accepts up to
64 MiB of internal JSON to carry sources and the restored cache.
The legacy API rate limits submissions to 10 per minute per Cloudflare location,
or 10 per minute per local process. Project snapshots use debounce instead of
that submission limit. It returns `429` with `Retry-After` when the
limit is reached. Polls and PDF downloads do not count toward that limit.

## Deploy to Cloudflare

Use a Workers Paid account with Containers enabled. Run `bun install` from
the repository root. With Docker running, create the required resources from `apps/compiler`:

```sh
bunx wrangler login
bunx wrangler r2 bucket create texfolia-compilations
bunx wrangler queues create texfolia-compile
```

Then deploy from the repository root:

```sh
bun run deploy
```

Reuse the bucket and queue if they already exist. Turbo builds the web app and deploys the compiler before the web app. The web app's Wrangler configuration binds `COMPILER` to
`texfolia-compiler`; production does not use `COMPILER_URL` or an internal token.
The Worker calls the container through its private Durable Object binding.

The configuration allows up to 20 active containers. Each project coordinator
routes only to `project:<projectId>`. An alarm retains the newest pending
snapshot during capacity shortages. Infrastructure failures retry up to four
times, with queue delivery as a fallback. The scheduled event recovers legacy
queue jobs. The `v2` migration adds the coordinator without replacing existing
container identities.

The engine's private HTTP interface provides `GET /health` returns
readiness, and `POST /compile` accepts the same project JSON as Hono. A successful
engine response is multipart form data with an `application/pdf` file named
`pdf`, a text field named `log`, and binary fields named `artifact:<path>` for
all other generated files. Failures return JSON with `error`, `log`, and the
full generated log in `logFile` when available.
`DELETE /compilations/<id>` cancels that run and responds after it exits.
The first `X-Project-Id` binds the engine process to that project; subsequent
requests for another project return `409`. Overlapping requests return `503` with `Retry-After: 1`. The engine has no job
API or persistent job data. Its image warms the base LaTeX format during build
and runs as an unprivileged user.

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

`builds.test.ts` checks full artifact retention, cache restoration, clean retry,
source invalidation, atomic publication through a storage failure, and expiry.

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
