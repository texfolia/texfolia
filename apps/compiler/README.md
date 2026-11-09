# Compiler

The Hono API accepts a project, returns a job URL, and lets you poll for its
result. On Cloudflare, the Worker stores the sources in R2 and sends the job ID
to Cloudflare Queues. The queue consumer calls a Tectonic container and stores the
PDF and diagnostics. The same Hono API runs locally with SQLite and calls the
same Go engine over HTTP.

The engine image contains a Go executable and Tectonic. It accepts one project
at a time, runs Tectonic in a temporary directory, and streams back the PDF and
bounded diagnostics. Hono owns job storage, queues, retries, and rate limits.

## Run locally

From the repository root, start Docker and run:

```sh
docker compose up --build compiler
```

The API listens at `http://localhost:8080`. The web app uses that address during
development; set `COMPILER_URL` to override it. Compose publishes the port only
on loopback. No internal token is needed.

Compose starts the private `latex-engine` service and reloads Hono when you edit
its source. Rebuild the engine after changing its Go source. The `compiler-data`
volume keeps queued jobs and PDFs across restarts.

To run without Docker, install Go 1.26 or later and Tectonic. Start the engine:

```sh
cd apps/compiler/engine
PORT=8081 go run .
```

In another terminal, run `bun run --cwd apps/compiler start` from the repository
root. `ENGINE_URL` defaults to `http://127.0.0.1:8081`.
Set `COMPILER_DB_PATH` to override `.cache/compiler.sqlite`. Both standalone
servers bind to `127.0.0.1`; their Docker images set `HOST=0.0.0.0`.

## API reference

Call the compiler from a trusted backend. In production, the web Worker uses the
`COMPILER` [service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)
to call the private `texfolia-compiler` Worker. The compiler has no public routes,
`workers.dev` URL, or preview URLs. The web app checks project
ownership before submitting sources, polling a job, or returning its PDF.

`GET /health` checks whether the API is ready to accept requests.

`POST /compile` accepts `application/json`:

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

`GET /jobs/<id>` returns a status of `queued`, `running`, `succeeded`, or
`failed`. Wait at least one second between polls. A successful job includes
`log`, `sizeBytes`, and `artifactUrl`. A failed job includes `error`, `log`,
and `errorStatus`, such as `422` for invalid LaTeX or `408` for a timeout.

`GET /compilations/<id>.pdf` returns the PDF after the job succeeds. The
artifact URL is relative to the compiler and uses the same private connection as
the job URL. The browser retrieves both through the web app's authenticated API.

Limits: 10 MiB of JSON, 200 files, 60 seconds per TeX run, and a 20 MiB PDF.
The API rate limits submissions to 10 per minute per Cloudflare location, or
10 per minute per local process. It returns `429` with `Retry-After` when the
limit is reached. Polls and PDF downloads do not count toward that limit.

## Deploy to Cloudflare

Use a Workers Paid account with Containers enabled. Run `bun install` from
the repository root. With Docker running, run these commands from
`apps/compiler`:

```sh
bunx wrangler login
bunx wrangler r2 bucket create texfolia-compilations
bunx wrangler queues create texfolia-compile
bun run deploy
```

Reuse the bucket and queue if they already exist. Deploy the compiler first,
then deploy the web app with `bun run --cwd apps/web deploy` from the repository
root. The web app's Wrangler configuration binds `COMPILER` to
`texfolia-compiler`; production does not use `COMPILER_URL` or an internal token.
The Worker calls the container through its private Durable Object binding.

The queue runs one job at a time to match the single container. A scheduled event
warms the container and recovers jobs whose queue send failed. The consumer
retries transient errors and records terminal failures. It removes the submitted
sources after saving a terminal result. Tectonic runs with `--untrusted`, without
service credentials, in a temporary directory that the container clears after
each run.

The engine's private HTTP interface has two endpoints: `GET /health` returns
readiness, and `POST /compile` accepts the same project JSON as Hono. A successful
engine response is multipart form data with an `application/pdf` file named
`pdf` and a text field named `log`. Failures return JSON with `error` and `log`.
Overlapping requests return `503` with `Retry-After: 1`. The engine has no job
API or persistent job data. Its image warms the base LaTeX format during build
and runs as an unprivileged user.

## Verify the compiler

```sh
bun run --cwd apps/compiler typecheck
bun run --cwd apps/compiler test
cd apps/compiler/engine
go test -race ./...
go vet ./...
cd ../../..
# With the API running, submit a multi-file project and invalid LaTeX:
bun run apps/compiler/test/smoke.ts
```

To run the smoke test against another local instance, set `COMPILER_URL`.
The production compiler is reachable only through a service binding.
