# @texfolia/projects

The project aggregate for the product app: project CRUD and settings, the
file-tree nodes, source paths, metadata versions, in-project search, and
owner and organization access.

| Entry point                 | Contents                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@texfolia/projects`        | Client-safe contracts: project and node request schemas, `projectMetadataSchema` and `projectMetadataVersion`, path helpers (`projectPaths`, `projectNodePaths`, `newProjectNodePath`, `renamedProjectNodes`, …), and `searchProject`            |
| `@texfolia/projects/server` | `lockProject`, `projectLock` and the `ProjectGrant` type; project operations (`createProject`, `getProjects`, `getProject`, `renameProject`, …); node operations; `readProjectMetadata`; `streamProjectResponse` for access-checked live streams |

Import only these entry points; `src/` paths are private.

## Access

`lockProject` locks a live project row (exclusively for writes, shared for
reads) and grants access to the owner of a personal project or to any member of
the project's organization. Every other kind of access is a `ProjectGrant`
passed in by the caller. Grants run in order after the owner and organization
checks. A grant returns `null` when it does not apply and throws to deny.

Operations that check access take a `lock` argument instead of importing a
fixed policy. Build it once with `projectLock(grants)`. The app composes
collaborator invitations and share links in
`apps/app/src/lib/project-access.server.ts` until sharing has its own package.

## Boundaries

This package depends on `@texfolia/db`, `@texfolia/auth` (organization roles),
`@texfolia/storage` (source uploads and the garbage queue),
`@texfolia/contracts`, and `@texfolia/editor` (the spelling-language schema
only). It does not invalidate builds, clean up collaboration rooms, or read
review comments. The app runs those after the operations here resolve (see
`apps/app/src/lib/project.server.ts`, `project-node.server.ts`, and
`project-metadata.server.ts`). Server-function wrappers, routes, and UI stay in
`apps/app`.

The project listing (`getProjects`, `accessibleProjects`) still reads
collaborator rows from `@texfolia/db` to show people and compute `canWrite`.

## Checks

```sh
bun run --cwd packages/projects test
bun run --cwd packages/projects typecheck
```

Database behavior is covered by the app's Postgres suites, such as
`apps/app/test/postgres.ts` and `apps/app/test/compile-route.ts`.
