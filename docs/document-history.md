# Document history (v1)

History is available from the workspace activity rail. Choose a text document to
browse versions, compare a version with the live text, download it, name it, or
restore it. Viewers can browse and download. Editors can create, name, and restore.
On narrow screens the history group expands to the workspace width.
Restore asks for confirmation and preserves the latest room text in a separate
version before applying a new collaborative edit. Existing versions are immutable
apart from their display labels.

## Storage and retention

Each project's collaboration Durable Object owns the version index and serializes
snapshots with edits. The first content edit archives the starting text. Subsequent
content edits start a five-minute window. Further edits do not postpone it. The
existing alarm handles source flushing, access checks, and snapshot deadlines.
Pending activity and contributor names persist in SQLite across hibernation and
runtime restarts. Contributors describe the version's activity window, not tracked
changes or line attribution. Saving a new named version also records its creator.

Versions are complete Yjs state updates, stored as binary objects at
`history/<projectId>/<nodeId>/<versionId>.yjs` in the existing SOURCES R2 bucket.
They do not reference source objects, which the source collector may remove.
Full updates avoid replay chains and make every retained version independently
recoverable. Storage grows with the encoded state times the number of versions.
Yjs state includes CRDT metadata, so it can exceed the text size. Existing document
and collaboration limits still apply. No new bucket or Postgres migration is needed.

All plans retain unnamed versions for 30 days. Naming a version keeps it until the
project is deleted. Pricing derives that claim from the same policy module. There
is no plan-specific retention rule in v1. The hourly registered-room sweep prunes
expired versions and interrupted uploads. Listing or comparing history also prunes
expired versions. Deleting a project removes its history during collaboration
cleanup, with the scheduled sweep retrying failures.

History covers text content only. Binary files, file names, folder structure,
and deleted-file recovery are outside v1. Versions belong to stable document IDs,
so renaming a live file does not lose its history. Deleted documents' versions
remain inaccessible and follow normal retention until project deletion. Named
versions are intentionally retained, even if their document was deleted.

Restoration edits the current Y.Text rather than applying the old Yjs update:
merging an older update cannot undo later CRDT deletions. Live and reconnecting
editors receive the new update normally. Concurrent offline edits merge as usual.
Restore uploads the new version before committing its index and CRDT edit in
one SQLite transaction. An upload failure leaves the current text unchanged.
History actions operate on server state. The UI waits for the acting editor's save
acknowledgement before saving a named version or restoring, so local edits reach the room first.

## Verification

Build the web app, then run the authenticated integration against an isolated
Postgres database with the current schema:

```sh
bun run --cwd apps/web build
INTEGRATION_DATABASE_URL=postgres://user:password@127.0.0.1:5432/texfolia_test bun run --cwd apps/web test:document-history
```

The integration uses the built React workspace, signed sessions, real Postgres,
and Miniflare's persistent SQLite/R2 storage. It checks automatic cadence, authors,
live comparison, naming, downloads, restore propagation and recovery, access rules,
retention, hibernation, runtime restart, pagination, mobile layout, and deletion
cleanup. CI runs it after the workspace metadata integration builds the app.
