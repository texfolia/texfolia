# Compile client

The product app's compile client: how `apps/app` starts a compile, follows it
to completion, reads its logs and history, and shares the latest PDF. The
compiler service itself is `apps/compiler`; this feature only talks to it.

| Entry point                 | Contents                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/features/compile`        | Client-safe helpers. Starting a compile: `compileDeltaSchema`, `hashSource`, `ProjectSourceSync`, `requestCompilation`. Following completion: `ProjectBuildEvents`, `trackCompilePreview`, `reportCompilePreview`. Logs and history: `parseCompileLog`, `compileHistorySchema`, `compileTimeline` and the history limits. Shared PDF: `sharedPdfReducer`, `sharedPdfStep`, `isCurrentBuild` |
| `#/features/compile/server` | `fetchCompiler` (the `COMPILER` service binding, or `COMPILER_URL` in development), `createCompileSources` (saved-source snapshots under the project lock), `createCompileHandlers` (the `/api/compile/$projectId` GET, POST and PATCH handlers)                                                                                                                                            |

Other features import only these entry points; the remaining files are private.

## Boundaries

The feature depends on `@texfolia/contracts` (the compiler protocol),
`@texfolia/db` (the `project_job` table and project nodes) and
`#/features/storage` (source objects). It does not know about authentication,
share links, billing, or the project aggregate. The app passes those in:

- `CompileProject` locks a project and checks access, returns the metadata
  version the browser sends as `X-Source-Metadata`, and maps nodes to paths.
- `createCompileHandlers` also takes `principal` (session or share link),
  `bucket` (the `SOURCES` R2 binding), `compilePlan` (billing), and `streamLive`
  (closes live streams when access is revoked).

`ProjectBuildEvents` takes an optional URL decorator, which the share view uses
to add its share token.

The app binds all of this in `apps/app/src/lib/compile-route.server.ts` and
`apps/app/src/lib/compile-source.server.ts`. The `/api/compile` route files, the
`COMPILER` service binding in Wrangler, and the workspace UI (Problems, Logs,
Terminal, preview) stay outside the feature.

## Checks

```sh
bun test apps/app/src/features/compile
```

The route's end-to-end behavior is covered by
`bun run --cwd apps/app test:compile-route`, which needs
`INTEGRATION_DATABASE_URL`.
