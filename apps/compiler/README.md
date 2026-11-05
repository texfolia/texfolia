# Compiler

A persistent Bun HTTP service with Tectonic installed and its base LaTeX cache
prepared at image build time. Each request starts a Tectonic subprocess in a fresh
temporary directory; the server and package cache stay warm. Additional packages
download on first use. One job runs at a time; concurrent callers receive `503`
with `Retry-After: 1`.

R2 is object storage. Production compute runs in **Cloudflare Containers**, behind
a Worker that saves successful PDFs to R2. Development runs the same image directly
in Docker and returns PDF bytes without Cloudflare credentials.

## Local development

From this directory, with Docker Desktop running:

```sh
docker compose up --build
```

The API listens at `http://localhost:8080`. Source changes reload automatically.
The image targets `linux/amd64`, matching Cloudflare Containers. The cache survives
jobs and is seeded in the image; extra downloaded packages last until the container
is recreated. `GET /health` reports readiness. No token is required locally.

## Compile a project

`POST /compile`, `Content-Type: application/json`:

```json
{
  "mainFile": "main.tex",
  "files": {
    "main.tex": "\\documentclass{article}\\begin{document}\\input{sections/hello}\\end{document}",
    "sections/hello.tex": "Hello from Texfolia!"
  }
}
```

`mainFile` defaults to `main.tex`. Paths are relative to the project root. Text
files are strings; binary assets use `{ "base64": "..." }`. The response is the PDF
(`application/pdf`). Failed LaTeX returns `422` JSON with `error` and compiler
`log`; timeout returns `408`. Limits: 10 MiB JSON, 200 files, 60 seconds per job,
20 MiB PDF. Temporary files are removed after success or failure. Tectonic runs
with `--untrusted` and no service credentials in its environment.

Call from a trusted backend. Production uses a shared bearer token; the backend
must enforce project ownership before submitting files or retrieving PDFs.

## Production

Run `bun install` from the repository root, then from this directory:

```sh
bunx wrangler login
bunx wrangler r2 bucket create texfolia-compilations
bunx wrangler secret put COMPILER_TOKEN
bun run deploy
```

Use a Workers Paid account with Containers enabled. Docker must be running during
deployment. Set `COMPILER_TOKEN` to a strong secret and send
`Authorization: Bearer <token>` on every Worker request, including health checks.
The container receives the secret through its environment; the TeX subprocess does not.

The singleton deliberately stays running after idle activity expires. A five-minute
cron starts it after deployment and recovers it after exits. The first request or
cron starts the instance; provisioning/restarts can still cause a cold start. This
is one continuously billed instance, not a zero-downtime guarantee.

For compiler diagnostics on successful builds, send `Accept: multipart/form-data`.
The response contains a PDF part named `pdf` and the compiler transcript in `log`.

The web backend sends its reserved project job UUID in `X-Compilation-Id` to
store a successful PDF in R2. The Worker returns the ID, `X-Compilation-Size`
in bytes, and a relative `Location` such as `/compilations/<uuid>.pdf`. An
authenticated `GET` at that location retrieves the PDF. Compile requests without
a job UUID return the result directly. The compiler receives the source files
with every request and clears its temporary directory when the job finishes.

## Checks

```sh
bun run typecheck
bun test
# With Docker Compose running, compile a real multi-file project and invalid LaTeX:
bun run test/smoke.ts
```
