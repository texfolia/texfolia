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
ownership before submitting sources, polling a job, or returning its PDF.

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
and `errorStatus`, such as `422` for invalid LaTeX or `408` for a timeout.

`GET /projects/<projectId>/compilations/<id>.pdf` returns the PDF after the job succeeds. The
artifact URL is relative to the compiler and uses the same private connection as
the job URL. The browser retrieves both through the web app's authenticated API.

`GET /projects/<projectId>` returns `revision`, `current`, and `latestBuild`.
Each build carries its ID, revision, source digest, status, and diagnostics.
A successful build includes its artifact URL and size. `latestBuild` is the
latest completed build. Comparing its revision with `revision` identifies a
stale build. These fields are the contract for `out/` persistence and stale UI.

`GET /projects/<projectId>/events` streams the same snapshot on attach and after
every transition. It sends heartbeat comments every 15 seconds. EventSource
reconnects with the current snapshot, so no replay cursor is needed. The editor
attaches when the project opens. It submits full source snapshots on save through
Cmd/Ctrl+S or **Save & compile**. Typing marks the preview stale and leaves the
saved build running. Delta sync and replacing the PDF polling loop are separate
work.

New revisions terminate superseded jobs with `status: "failed"` and an explicit
superseded error. Cancellation waits for the Go engine to stop the old TeX
process. Late responses cannot publish a build for an older revision. The
coordinator keeps one pending snapshot, replacing it on each submission.

The legacy `/compile`, `/jobs/<id>`, and `/compilations/<id>.pdf` endpoints remain
available for existing jobs. They retain their queue and rate limit.

Limits: 10 MiB of JSON, 200 files, 60 seconds per TeX run, and a 20 MiB PDF.
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
`pdf` and a text field named `log`. Failures return JSON with `error` and `log`.
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
