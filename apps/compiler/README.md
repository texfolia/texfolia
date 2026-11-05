# Compiler

The Hono API accepts a project, returns a job URL, and lets you poll for its
result. On Cloudflare, the Worker stores the sources in R2 and sends the job ID
to Cloudflare Queues. The queue consumer calls a Tectonic container and stores the
PDF and diagnostics. The same API runs locally with SQLite and Tectonic.

## Run locally

From the repository root, start Docker and run:

```sh
docker compose up --build compiler
```

The API listens at `http://localhost:8080`. Set the web app's `COMPILER_URL` to
that address. Compose binds the port to loopback and does not require a token.
Set `COMPILER_TOKEN` in both services if you enable local authentication.

Compose reloads the compiler when you edit its source. The `compiler-data`
volume keeps queued jobs and PDFs across restarts. To run without Docker,
install Tectonic and run `bun run --cwd apps/compiler start`. Set
`COMPILER_DB_PATH` to override the default `.cache/compiler.sqlite` path.

## API reference

Call the compiler from a trusted backend. In production, send
`Authorization: Bearer <token>` on every request. The web app checks project
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
artifact URL requires the same authentication as the job URL.

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
bunx wrangler secret put COMPILER_TOKEN
bun run deploy
```

Reuse the bucket and queue if they already exist. Configure the web app with the
Worker URL and the same `COMPILER_TOKEN`. Deploy the web app and Worker together
because the submission response changed from a PDF to a job URL.

The queue runs one job at a time to match the single container. A scheduled event
warms the container and recovers jobs whose queue send failed. The consumer
retries transient errors and records terminal failures. It removes the submitted
sources after saving a terminal result. Tectonic runs with `--untrusted`, without
service credentials, in a temporary directory that the container clears after
each run.

## Verify the compiler

```sh
bun run --cwd apps/compiler typecheck
bun run --cwd apps/compiler test
# With the API running, submit a multi-file project and invalid LaTeX:
bun run apps/compiler/test/smoke.ts
```

To run the smoke test against another instance, set `COMPILER_URL` and, if that
instance requires it, `COMPILER_TOKEN`.
