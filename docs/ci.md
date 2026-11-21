# CI selection and caches

The CI workflow runs on pull requests and on every push to `main`. It keeps two
jobs, `Checks` and `App database with plain Postgres`. Each job runs
`scripts/ci-select.mjs` with full Git history.

On pull requests, the selector diffs against the pull request base SHA. Selection
uses the merge-base diff, including deleted paths and both sides of renames.
Missing history selects every check.

On pushes to `main`, the workflow sets `CI_FULL_RUN=true` and every check runs
without a Turbo filter. Each commit on `main` is checked as merged, which catches
breakage from merge order or direct pushes that a pull request diff would miss.
These runs also save Turbo caches in the `main` scope, which pull requests can
restore.

## Check inputs

Turbo typecheck, unit test, package lint, and package format tasks use
`--filter=...[<PR base SHA>]`, which includes changed packages and their dependents.
Compiler runtime and fixture changes also select web tasks because web tests import
those files outside the package dependency graph. Repository link checks, root
Oxlint, and root Oxfmt always run, including on documentation changes.

Changes to shared packages, the lockfile, root configuration, CI configuration,
root scripts, environment files, Wrangler configuration, generated binding types,
or schema files select the full current set. Unknown root inputs also select
all checks. Changes confined to documentation skip package tests and browser
suites. A web unit test change selects web checks without integration suites.

Runtime web changes select every Postgres suite and production-assets because
browser suites exercise the built app. The map stays broad until narrower runtime
dependencies can be proven. Changes confined to a mapped integration test select
only its owners in the table below. Unknown web test helpers select every
Postgres suite and production-assets.

| Suite                       | Test inputs under `apps/app/test`                                                      | Additional inputs                                                                     | Production build | Chromium |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------- | -------- |
| database                    | `postgres.ts`, `postgres/`                                                             | Runtime web inputs                                                                    | No               | No       |
| compile-route               | `compile-route.ts`, `compile-route/`                                                   | Runtime web inputs, compiler runtime                                                  | No               | No       |
| ai-billing                  | `ai-billing.ts`                                                                        | Runtime web inputs                                                                    | No               | No       |
| assistant                   | `ai-assistant.ts`                                                                      | Runtime web inputs                                                                    | Yes              | Yes      |
| collaboration               | `collaboration.ts`, `collaboration/`, `collaboration-cache.ts`, `collaboration-cache/` | Runtime web inputs                                                                    | No               | Yes      |
| workspace-metadata          | `workspace-metadata.ts`                                                                | Runtime web inputs                                                                    | Yes              | Yes      |
| ui-overhaul                 | `ui-overhaul.ts`, `pdf-fixture.ts`                                                     | Runtime web inputs                                                                    | Yes              | Yes      |
| git                         | `git-integration.ts`, `git/`                                                           | Runtime web inputs                                                                    | No               | No       |
| source-storage              | `source-storage.ts`, `source-storage/`, `worker-integration.ts`                        | Runtime web inputs                                                                    | No               | No       |
| projects                    | `projects.ts`, `projects/`, `worker-integration.ts`                                    | Runtime web inputs                                                                    | No               | No       |
| templates                   | `templates.ts`, `templates/`, `worker-integration.ts`                                  | Runtime web inputs                                                                    | No               | No       |
| template-seed               | None                                                                                   | Runtime web inputs, shared packages including `packages/db/test/template-seed-cli.ts` | No               | No       |
| template-lifecycle          | `template-lifecycle.ts`, `template-pages.ts`                                           | Runtime web inputs, compiler runtime                                                  | Yes              | Yes      |
| production-assets in Checks | `production-assets.ts`                                                                 | Runtime web inputs                                                                    | Yes              | Yes      |

The browser rows are the existing end-to-end coverage. There is no separate
`e2e` package script in the current workflow. Compiler-only Go changes run the
compiler checks and skip web production assets and Postgres suites. Compiler
runtime changes also run compile-route and template-lifecycle. Shared package
changes, including the path-policy fixture in `packages/contracts`, run every
check.

Both jobs publish their selection in the step log. The selector regression cases
run with `node --test scripts/ci-select.test.mjs` in Checks.

## Cache behavior

The shared setup action in `.github/actions/setup-ci/action.yml` restores Bun's
download cache before a frozen install. The key includes the runner OS,
architecture, Bun version, and lockfile, with a fallback for older lockfiles.
`node_modules` is installed fresh.

Turbo's local `.turbo` cache persists through GitHub Actions caches. Keys include
the runner OS, architecture, Bun version, job, lockfile, and commit. Restore keys
allow task reuse across commits. Turbo validates individual task hashes after
restoration. No remote cache service or credentials are required. GitHub's cache
scope rules still apply, so a new PR may start cold if no accessible cache exists.

Turbo hashes the default package inputs plus shared TypeScript, lint, format, CI,
and environment configuration. Web typecheck hashes compiler runtime files.
Shared packages such as `packages/contracts` are workspace dependencies, so
their changes invalidate the tasks of the apps that import them. Go tests and
lint hash the Go version, Go flags, target architecture, and CGO setting. Go cache
locations pass through without affecting task hashes. Setup-go restores both
module and build caches using `apps/compiler/engine/go.sum`.

Chromium binaries are cached by runner OS, architecture, and the installed
Playwright version. The installer runs on cache hits too, to install Linux system
libraries. Browser and database suites run directly and never cache their test
results.

Each job builds web through Turbo at most once when its selected suites need the
production app. Build outputs include `dist`, `.wrangler/deploy`, and the generated
`public/core` assets. Workspace metadata and template lifecycle use their
`:prebuilt` commands in CI. Their regular local commands still build first.

Job splitting, concurrency cancellation, a wall-time target, and compiler Docker
builds remain outside the current workflow.
