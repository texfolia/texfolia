# Source storage

Source-object storage for the product app: the R2 objects that hold project
file contents, their keys and size limits, and the garbage-collection queue
that deletes objects no live node references.

| Entry point             | Contents                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/storage`         | Client-safe contracts: file and project size limits, `sourceContentSchema`, `saveSourceSchema`, `sourceHashFromKey`, base64 encoding, file kinds, path checks                                                                                                                                             |
| `#/lib/storage/server`  | `SourceBucket`, `prepareSource` (hash and check), `storeSource` (upload one ahead of the commit), `commitSources` (upload, then commit, cleaning up on rollback), `checkProjectQuota`, `copySource` (verified copy under another prefix), `retireSources` (queue), `collectSourceGarbage`, `deletePrefix` |
| `#/lib/storage/zip`     | `zipStream` and `createZip`, an uncompressed ZIP writer used for project and account downloads                                                                                                                                                                                                            |
| `#/lib/storage/browser` | DOM helpers: reading dropped files and folders, and `downloadFile`                                                                                                                                                                                                                                        |

Other features import only these entry points; the remaining files are private.

## Object keys

Sources are stored at `projects/<projectId>/sources/<uuid>-<sha256>`. Every
upload writes to a unique UUID-prefixed key (while still embedding the SHA-256
content hash so compilers and Git can read it without fetching bytes). When a
node is replaced or deleted, `retireSources` queues the old key in
`source_garbage` inside the same transaction as the node change, and
`collectSourceGarbage` later deletes queued keys that no live node still
references. Projects in the trash keep their sources; only a deleted project row
releases them. Account and organization deletions queue owned project sources in
`source_garbage` via `deletionNotice`.

## Collection

Transactions never stay open during R2 calls, and unique per-upload keys ensure
collection can never race with a concurrent upload:

- Collection waits an hour after a key is retired. Readers look keys up in a
  transaction and read the objects afterward, well within that time.
- Because a retired key is never reused by a new upload, `collectSourceGarbage`
  deletes unreferenced keys directly and removes their `source_garbage` rows
  without taking a project lock or running a two-phase claim.
- `commitSources` uploads first, then runs its transaction. If the transaction
  fails or rolls back, it deletes the newly uploaded unique keys immediately.

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
