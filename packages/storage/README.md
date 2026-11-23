# @texfolia/storage

Source-object storage for the product app: the R2 objects that hold project
file contents, their keys and size limits, and the garbage-collection queue
that deletes objects no live node references.

| Entry point                 | Contents                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@texfolia/storage`         | Client-safe contracts: file and project size limits, `sourceContentSchema`, `saveSourceSchema`, base64 encoding, file kinds, path checks         |
| `@texfolia/storage/server`  | `SourceBucket`, `putSource` (content-addressed upload with quota checks), `retireSources` (queue), `collectSourceGarbage`, `sweepProjectSources` |
| `@texfolia/storage/zip`     | `createZip`, an uncompressed ZIP writer used for project and template downloads                                                                  |
| `@texfolia/storage/browser` | DOM helpers: reading dropped files and folders, and `downloadFile`                                                                               |

Import only these entry points; `src/` paths are private.

## Object keys

Sources are stored at `projects/<projectId>/sources/<sha256>`. Identical
content in one project shares one object, so a replaced or deleted node does
not delete its object directly. Instead `retireSources` queues the key in
`source_garbage` inside the same transaction as the node change, and
`collectSourceGarbage` later deletes queued keys that no live node still
references. `sweepProjectSources` lists the whole prefix as a daily safety net
for uploads whose transaction rolled back and for projects removed by cascades.

## Boundaries

This package depends on `@texfolia/db` and `@texfolia/contracts` only. It does
not check project access, invalidate builds, or clean up collaboration state:
the app composes those around these primitives (see
`apps/app/src/lib/project-source.server.ts`). Route wiring and the `SOURCES` R2
binding stay in `apps/app`.

## Checks

```sh
bun run --cwd packages/storage test
bun run --cwd packages/storage typecheck
```

The ZIP test shells out to `unzip` and `python3`.
