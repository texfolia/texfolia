# Projects

The project aggregate for the product app: project CRUD and settings, the
file-tree nodes, source paths, metadata versions, in-project search, and
owner and organization access.

| Entry point                  | Contents                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/features/projects`        | Client-safe contracts: project and node request schemas, `projectMetadataSchema` and `projectMetadataVersion`, path helpers (`projectPaths`, `projectNodePaths`, `newProjectNodePath`, `renamedProjectNodes`, …), and `searchProject`                                                                                                                                                     |
| `#/features/projects/server` | `lockProject`, `projectLock` and the `ProjectGrant` type; project operations (`createProject`, `getProjects`, `getProject`, `renameProject`, …); `duplicateProject`; the trash (`trashProject`, `restoreProject`, `deleteTrashedProject`, `deleteExpiredProjects`, `getTrashedProjects`); node operations; `readProjectMetadata`; `streamProjectResponse` for access-checked live streams |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path.

## Access

`lockProject` locks a live project row (exclusively for writes, shared for
reads) and grants access to the owner of a personal project or to any member of
the project's organization. Every other kind of access is a `ProjectGrant`
passed in by the caller. Grants run in order after the owner and organization
checks. A grant returns `null` when it does not apply and throws to deny.

Operations that check access take a `lock` argument instead of importing a
fixed policy. Build it once with `projectLock(grants)`. `project-access.server.ts`
in `#/features/sharing` adds collaborator invitations and share links.

`requireProjectManager` is the stricter check for trashing, restoring,
permanently deleting, and transferring: the personal owner, or an organization
owner or admin. Transfer lives in `#/features/sharing` because it changes
collaborators and share links.

## Boundaries

This feature depends on `@texfolia/db`, `#/features/auth` (organization roles),
`#/features/storage` (source uploads and the garbage queue),
`@texfolia/contracts`, and `#/features/editor` (the spelling-language schema
only).
The core operations (`projects.server.ts`, `trash.server.ts`,
`duplicate.server.ts`, `nodes.server.ts`, `metadata.server.ts`) take the lock and do not invalidate builds, clean up
collaboration rooms, or read review comments. The `project*.server.ts` modules
bind them to the app's access check and run that work afterward:
`project.server.ts`, `project-node.server.ts`, `project-metadata.server.ts`,
`project-source.server.ts` (saving, reading, and deleting sources), and
`project-import.server.ts`. The matching `project*.functions.ts` modules are the
server functions. Use these bound modules from routes and other features.

The project listing (`getProjects`, `accessibleProjects`) still reads
collaborator rows from `@texfolia/db` to show people and compute `canWrite`.

## Checks

```sh
bun test apps/app/src/features/projects
```

Database behavior is covered by the app's Postgres suites, such as
`apps/app/test/projects.ts`, `apps/app/test/postgres.ts`, and `apps/app/test/compile-route.ts`.
