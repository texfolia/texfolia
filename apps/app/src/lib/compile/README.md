# Compile client

The product app's compile client: how `apps/app` starts a compile, follows it
to completion, reads its logs and history, and shares the latest PDF.
[`#/lib/builds`](../builds/README.md) runs the builds; this feature only talks to
it.

| Entry point            | Contents                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/compile`        | Client-safe helpers. Starting a compile: `compileDeltaSchema`, `hashSource`, `ProjectSourceSync`, `requestCompilation`. Following completion: `ProjectBuildEvents`, `trackCompilePreview`, `reportCompilePreview`. Logs and history: `parseCompileLog`, `compileHistorySchema`, `compileTimeline` and the history limits. Shared PDF: `sharedPdfReducer`, `sharedPdfStep`, `isCurrentBuild` |
| `#/lib/compile/server` | `createCompileSources` (saved-source snapshots, and whether a submitted one is still current), `createCompileHandlers` (the `/api/compile/$projectId` GET, POST and PATCH handlers)                                                                                                                                                                                                         |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path.

## Boundaries

The feature depends on `@texfolia/contracts` (build schemas), `#/lib/builds`,
`@texfolia/db` (the `project_job` table and project nodes) and
`#/lib/storage` (source encoding). The core does not know about
authentication, share links, billing, or the project aggregate. It takes those as
arguments:

- `CompileProject` locks a project and checks access, returns the metadata
  version the browser sends as `X-Source-Metadata`, and maps nodes to paths.
- `createCompileHandlers` also takes `principal` (session or share link),
  and `compilePlan` (billing).

`ProjectBuildEvents` takes an optional URL decorator, which the share view uses
to add its share token.

`compile-route.server.ts` and `compile-source.server.ts` bind all of this.
`build.ts` builds the URLs of build files. The `/api/compile` route files, the
`BUILDS` binding in Wrangler, and the workspace UI (Problems, Logs,
Terminal, preview) stay outside the feature.

## Checks

```sh
bun test apps/app/src/lib/compile
```

The route's end-to-end behavior is covered by
`bun run --cwd apps/app test:compile-route`, which needs
`INTEGRATION_DATABASE_URL`.
