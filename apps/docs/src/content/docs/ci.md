---
title: CI selection and caches
---

The CI workflow runs on pull requests and on every push to `main`. It has four
jobs: `Checks`, `App database with plain Postgres`, `Browser suites`, and
`LaTeX engine`. Each job runs `scripts/ci-select.mjs` with full Git history.

A newer push to a pull request cancels that pull request's older run. Runs on
`main` are never canceled, so each commit there has its own result.

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
those files outside the package dependency graph. Build history, admission, and
queue code is web code. Repository link checks, root
Oxlint, and root Oxfmt always run, including on documentation changes.

Changes to shared packages, the lockfile, root configuration, CI configuration,
root scripts, environment files, Wrangler configuration, generated binding types,
or schema files select the full current set. Unknown root inputs also select
all checks. Changes confined to documentation skip package tests and browser
suites. A web unit test change selects web checks without integration suites.

Runtime web changes select every suite and production-assets because
browser suites exercise the whole app. The map stays broad until narrower runtime
dependencies can be proven. Changes confined to a mapped integration test select
only its owners in the table below. Unknown web test helpers select every suite
and production-assets. Any change to the compiler selects the engine suites.

A unit test keeps the selector and the workflow's steps together:
each suite must run in its own job.

| Suite              | Test inputs under `apps/app/test`                                                      | Additional inputs                                                                     | Job          | Production build | Chromium |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------ | ---------------- | -------- |
| settings           | `settings.ts`                                                                          | Runtime web inputs                                                                    | Postgres     | No               | No       |
| pricing            | `pricing.ts`                                                                           | Runtime web inputs                                                                    | Postgres     | Yes              | Yes      |
| login              | `login.ts`                                                                             | Runtime web inputs                                                                    | Browser      | No               | Yes      |
| editor-keymaps     | `editor-keymaps.ts`, `editor-keymaps/`                                                 | Runtime web inputs                                                                    | Browser      | No               | Yes      |
| spelling           | `spelling.ts`, `spelling/`                                                             | Runtime web inputs                                                                    | Browser      | No               | Yes      |
| synctex            | `synctex.ts`, `fixtures/synctex/`, `editor-runtime/`, `workspace-upload/`              | Runtime web inputs                                                                    | Browser      | No               | Yes      |
| themes             | `theme-preview.ts`, `editor-runtime/`, `workspace-upload/`                             | Runtime web inputs                                                                    | Browser      | No               | Yes      |
| editor-runtime     | `editor-runtime.ts`, `editor-runtime/`, `workspace-upload/`, `pdf-fixture.ts`          | Runtime web inputs                                                                    | Browser      | No               | Yes      |
| editor-features    | `editor-features.ts`, `editor-runtime/`, `workspace-upload/`, `pdf-fixture.ts`         | Runtime web inputs                                                                    | Browser      | No               | Yes      |
| compile-engine     | `compile-engine.ts`                                                                    | Runtime web inputs, anything in the compiler                                          | LaTeX engine | No               | No       |
| workspace-upload   | `workspace-upload.ts`, `workspace-upload/`, `editor-runtime/`                          | Runtime web inputs, anything in the compiler                                          | LaTeX engine | No               | Yes      |
| database           | `postgres.ts`, `postgres/`                                                             | Runtime web inputs                                                                    | Postgres     | No               | No       |
| compile-route      | `compile-route.ts`, `compile-route/`                                                   | Runtime web inputs, compiler runtime                                                  | Postgres     | No               | No       |
| ai-billing         | `ai-billing.ts`                                                                        | Runtime web inputs                                                                    | Postgres     | No               | No       |
| assistant          | `ai-assistant.ts`                                                                      | Runtime web inputs                                                                    | Postgres     | Yes              | Yes      |
| collaboration      | `collaboration.ts`, `collaboration/`, `collaboration-cache.ts`, `collaboration-cache/` | Runtime web inputs                                                                    | Postgres     | No               | Yes      |
| workspace-metadata | `workspace-metadata.ts`                                                                | Runtime web inputs                                                                    | Postgres     | Yes              | Yes      |
| ui-overhaul        | `ui-overhaul.ts`, `pdf-fixture.ts`                                                     | Runtime web inputs                                                                    | Postgres     | Yes              | Yes      |
| git                | `git-integration.ts`, `git/`                                                           | Runtime web inputs                                                                    | Postgres     | No               | No       |
| source-storage     | `source-storage.ts`, `source-storage/`, `worker-integration.ts`                        | Runtime web inputs                                                                    | Postgres     | No               | No       |
| projects           | `projects.ts`, `projects/`, `worker-integration.ts`                                    | Runtime web inputs                                                                    | Postgres     | No               | No       |
| templates          | `templates.ts`, `templates/`, `worker-integration.ts`                                  | Runtime web inputs                                                                    | Postgres     | No               | No       |
| template-seed      | None                                                                                   | Runtime web inputs, shared packages including `packages/db/test/template-seed-cli.ts` | Postgres     | No               | No       |
| template-lifecycle | `template-lifecycle.ts`, `template-pages.ts`                                           | Runtime web inputs, compiler runtime                                                  | Postgres     | Yes              | Yes      |
| production-assets  | `production-assets.ts`, `login.ts`, `pdf-fixture.ts`                                   | Runtime web inputs                                                                    | Checks       | Yes              | Yes      |

The browser rows are the existing end-to-end coverage. There is no separate
`e2e` package script in the current workflow. Compiler-only Go changes run the
compiler checks and the engine suites, and skip web production assets, Postgres,
and the browser job. Compiler runtime changes also run compile-route and
template-lifecycle. Shared package
changes, including the path-policy fixture in `packages/contracts`, run every
check.

Every job publishes its selection in the step log. The selector regression cases
run with `node --test scripts/ci-select.test.mjs` in Checks.

`test:billing` stays outside CI because it needs Stripe sandbox credentials.

## LaTeX engine

The `LaTeX engine` job builds `apps/compiler/Dockerfile`, starts the image, and
runs the source path, template preview, and biber security checks against it
before its suites. Its layers are cached through GitHub Actions, so a change to
the Go engine rebuilds only the last ones. A change to Tectonic, biber, or an
earlier layer compiles Tectonic again, which takes several minutes.

## Lint

Root Oxlint uses type information, through `oxlint-tsgolint`, so it reports
floating and misused promises. It also checks React, hooks, and accessibility.
`.oxlintrc.json` says why each disabled rule is disabled. Disable a rule on one
line with `oxlint-disable-next-line` and a reason.

`bun run check:repo` also checks that links between Markdown files reach an
existing file and heading.

## Cache behavior

The shared setup action in `.github/actions/setup-ci/action.yml` restores Bun's
download cache before a frozen install. The key includes the runner OS,
architecture, Bun version, and lockfile, with a fallback for older lockfiles.
`node_modules` is installed fresh.

Turbo's local `.turbo` cache persists through GitHub Actions caches. Keys include
the runner OS, architecture, Bun version, job, lockfile, and commit. Restore keys
allow task reuse across commits. `cacheMaxSize` in `turbo.json` drops the oldest
entries over 200 MB, because each run restores the previous cache and GitHub
evicts caches once the repository's exceed 10 GB. Turbo validates individual task hashes after
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

The Checks and Postgres jobs each build web through Turbo at most once when their selected suites need the
production app. Build outputs include `dist`, `.wrangler/deploy`, and the generated
`public/core` assets. Pricing, workspace metadata, and template lifecycle use their
`:prebuilt` commands in CI. Their regular local commands still build first.

A wall-time target remains outside the current workflow.
