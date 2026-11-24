# Source storage

Source-object storage for the product app: the R2 objects that hold project
file contents, their keys and size limits, and the garbage-collection queue
that deletes objects no live node references.

| Entry point             | Contents                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/storage`         | Client-safe contracts: file and project size limits, `sourceContentSchema`, `saveSourceSchema`, base64 encoding, file kinds, path checks                                                            |
| `#/lib/storage/server`  | `SourceBucket`, `putSource` (content-addressed upload with quota checks), `copySource` (verified copy under another prefix), `retireSources` (queue), `collectSourceGarbage`, `sweepProjectSources` |
| `#/lib/storage/zip`     | `createZip`, an uncompressed ZIP writer used for project and template downloads                                                                                                                     |
| `#/lib/storage/browser` | DOM helpers: reading dropped files and folders, and `downloadFile`                                                                                                                                  |

Other features import only these entry points; the remaining files are private.

## Object keys

Sources are stored at `projects/<projectId>/sources/<sha256>`. Identical
content in one project shares one object, so a replaced or deleted node does
not delete its object directly. Instead `retireSources` queues the key in
`source_garbage` inside the same transaction as the node change, and
`collectSourceGarbage` later deletes queued keys that no live node still
references. Projects in the trash keep their sources; only a deleted project row
releases them. `sweepProjectSources` lists the whole prefix as a daily safety net
for uploads whose transaction rolled back and for projects removed by cascades.

## Boundaries

This feature depends on `@texfolia/db` and `@texfolia/contracts` only. It does
not check project access, invalidate builds, or clean up collaboration state:
`project-source.server.ts` in `#/lib/projects` composes those around
these primitives. Route wiring and the `SOURCES` R2
binding stay outside the feature.

## Checks

```sh
bun test apps/app/src/lib/storage
```

The ZIP test shells out to `unzip` and `python3`.
