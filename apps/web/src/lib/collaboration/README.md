# Collaboration

Yjs collaboration for project sources: the Durable Object room that syncs,
persists, and flushes collaborative text, the binary WebSocket protocol, and
the browser side (the project's live documents, the Yjs document for an open
file, and its IndexedDB cache).

| Entry point                   | Contents                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `#/lib/collaboration`         | The wire protocol: `encodeClientMessage`, `decodeClientMessage`, `encodeServerMessage`, `decodeServerMessage`, `awarenessFrame`, `readAwareness`, `collaborationProtocol`, `protocolSearchParam`, `peopleSearchParam`, `outdatedClientMessage`, `maxCollaborationBytes`, `scratchpadId`, `documentIdSchema`. Safe to import anywhere |
| `#/lib/collaboration/browser` | `CollaborativeDocuments`, which connects documents on demand; `CollaborativeFile`; the IndexedDB cache helpers `clearCollaborationCaches`, `collaborationCachePrefix`, `documentCachingStopped`, `stopDocumentCaching`                                                                                                               |
| `#/lib/collaboration/server`  | `collaborationAccess` and `scratchpadAccess` (the `/api/collaboration` access checks), `cleanupDeletedCollaboration`, `collectCollaborationSources`. Does not load the Workers runtime, so Bun tests can import it                                                                                                                   |
| `#/lib/collaboration/room`    | `CollaborationRoom` (the abstract Durable Object base class) and `CollaborationEnv`. Imports `cloudflare:workers`, so only Worker code loads it                                                                                                                                                                                      |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path.

## Boundaries

The feature depends on `@texfolia/db` (project nodes and the
`project_collaboration` registry), `#/lib/storage` (source objects),
`#/lib/projects` (the access request type and live-access interval),
`#/lib/duty-alarm` (one alarm shared by saving and access checks), and
`@texfolia/editor` (`formatChanges`, a text diff with no CodeMirror imports). It
owns `yjs`, `y-protocols`, `y-indexeddb`, and `lib0`. It does not depend on
CodeMirror; the `y-codemirror.next` binding stays in the editor route.

`CollaborationRoom` is abstract. `project-collaboration.server.ts`
subclasses it as `ProjectCollaboration`, and `src/worker.ts` exports that class, so Wrangler keeps binding `ProjectCollaboration`. The subclass
supplies what collaboration does not own:

- `lockProject` locks the project and checks access, including collaborator and
  share-link grants.
- `lockReaders` is the same check for several people in one transaction.
- `isAnonymous` marks share-link principals, which have no presence.
- `sourcesChanged` runs after the room persists sources (the app invalidates
  the compiler's build).

The scratchpad is the one document that is not a file. It uses the reserved ID
`scratchpad` instead of a node ID and `scratchpadAccess` instead of
`collaborationAccess`, and the room's storage is its only copy: it has no node or
source object, is never dirty, and is not flushed or reconciled. Deleting the
project removes it. `readScratchpad` is the RPC behind the assistant's tool. In
the browser it has its own `CollaborativeDocuments`, so saving, compiling, Git,
and export never include it.

Work on a document runs in its own queue. Loading a document, and delivering to
someone whose access is unknown, wait for a database inside it. Saving does not: it
takes the text in the queue, stores it outside, and records the version in the
queue again. The `saves` table lists objects that unfinished saves may have
committed, so a lost answer is not mistaken for a change made elsewhere. A node
read outside the queue is only applied while the document is at the version it had
before the read.

Operations that read saved sources outside collaboration, such as Git, go through
the protected `withSavedSources`, which saves dirty documents first. An operation
that rewrites sources does so inside the `exclusively` it receives: that holds off
edits, saves the latest ones, and brings open documents up to date afterward. Keep
slow work, such as requests to a Git host, outside it. The app's `gitAction` RPC
uses both.

`collaborationAccess` takes the same lock. `CollaborativeFile` takes
`anonymous` for share-link guests, who have no presence. Their HttpOnly share
cookie authenticates the socket, so the URL never carries a token.

`CollaborativeDocuments` connects a document while something holds it. Releasing
the last hold saves its unacknowledged edits and closes it. `unsynced.ts` marks
documents with unacknowledged edits so a later session can merge them.

The `/api/collaboration` route, Wrangler bindings and migrations, and the
CodeMirror binding stay outside the feature.

## Checks

```sh
bun test apps/app/src/lib/collaboration
```

End-to-end behavior is covered by `bun run --cwd apps/app test:collaboration`
and `test:collaboration-cache`.
