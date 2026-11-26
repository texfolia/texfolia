# Product app

The Texfolia workspace at `app.texfolia.com`: accounts, projects, the
CodeMirror editor, real-time collaboration, builds, billing and the AI
assistant. TanStack Start + React on Cloudflare Workers, with PostgreSQL through
Hyperdrive and project sources in R2.

## Develop

From the repository root, after [first-time setup](../../README.md#quick-start):

```sh
bun run dev:app   # Postgres and this app at localhost:3000
bun run dev       # every app, including the compiler that builds PDFs
```

Secrets live in `apps/app/.env` (copied from `.env.example`). The
[local development guide](../docs/src/content/docs/local-development.md) covers
Stripe, Turnstile and OAuth credentials.

## Commands

Run with `bun run --cwd apps/app <command>`.

| Command           | What it does                                                   |
| ----------------- | -------------------------------------------------------------- |
| `dev`             | Copy LaTeX and dictionary assets, then start Vite on port 3000 |
| `build`           | Production build for Cloudflare Workers                        |
| `test`            | Unit tests with `bun test`                                     |
| `test:<suite>`    | Browser and database suites in `test/`, such as `test:login`   |
| `typecheck`       | `tsc --noEmit`                                                 |
| `generate-routes` | Rewrite `src/routeTree.gen.ts`                                 |
| `auth:schema`     | Regenerate the Better Auth tables in `packages/db`             |
| `billing:setup`   | Create or reuse the Stripe sandbox prices                      |
| `cf:typegen`      | Rewrite `worker-configuration.d.ts` after changing bindings    |

## Layout

```text
src/routes/   File-based routes and API endpoints
src/lib/      Features: ai, auth, billing, builds, collaboration, editor, git, projects, ...
src/components/  Shared React components
test/         Browser and integration suites
scripts/      Asset copying, route generation and billing setup
```

## More

- [Architecture](ARCHITECTURE.md): storage, collaboration, accounts, styling,
  deployment and verification.
- [Design](DESIGN.md) and [product](PRODUCT.md) notes.
- Each feature folder in `src/lib` has its own README.
