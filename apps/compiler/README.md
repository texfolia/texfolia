# Compiler

The compile service. A Cloudflare Worker (`texfolia-compiler`) sits in front of
an autoscaled pool of Tectonic containers. It takes one archive of sources and
options and returns the PDF, SyncTeX data, logs and timing. It stores no jobs or
PDFs; the product app owns build history.

Locally the same program runs under Bun at `http://localhost:8080` and starts
engine containers through Docker.

## Develop

From the repository root:

```sh
bun run dev:compiler   # build the engine image, then start the compiler
```

`bun run dev` starts it together with the other apps. The first image build
downloads the base LaTeX packages and takes a while; later builds reuse
Docker's cache. Remove leftover engine containers with
`docker ps -aq --filter label=texfolia.compiler | xargs docker rm -f`.

## Commands

Run with `bun run --cwd apps/compiler <command>`.

| Command        | What it does                                                    |
| -------------- | --------------------------------------------------------------- |
| `dev`          | Build the engine image and start the compiler with a file watch |
| `engine:build` | Build the `texfolia-latex-engine:local` Docker image            |
| `test`         | TypeScript tests, then the Go engine tests                      |
| `lint`         | `go vet` the engine                                             |
| `typecheck`    | `tsc --noEmit`                                                  |
| `deploy`       | Deploy the Worker and its container image                       |

The Go tests and `lint` need Go and a C compiler on `PATH`.

## Layout

```text
worker.ts   Cloudflare Worker entry with the pool and container classes
src/        Compile service, autoscaler, container pool and the local Bun server
engine/     Go HTTP engine that runs inside each container
tectonic/   Patches applied to Tectonic when the image builds
biber/      Patch that keeps documents from running code through biber
warmup/     Documents compiled into the image to prime its package cache
scripts/    Verification scripts that run against a live engine
test/       Unit tests and engine integration checks
```

The wire format is in [`@texfolia/contracts/compiler`](../../packages/contracts/README.md).
The app's side of a build is in [`apps/web/src/lib/builds`](../web/src/lib/builds/README.md).
