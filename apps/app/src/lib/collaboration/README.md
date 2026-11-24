# Collaboration

Yjs collaboration for project sources: the Durable Object room that syncs,
persists, and flushes collaborative text, the binary WebSocket protocol, and
the browser side (the project's live documents, the Yjs document for an open
file, its IndexedDB cache, and the localStorage draft cache).

| Entry point                   | Contents                                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/lib/collaboration`         | The wire protocol: `encodeClientMessage`, `decodeClientMessage`, `encodeServerMessage`, `decodeServerMessage`, `awarenessFrame`, `readAwareness`, `collaborationProtocol`, `protocolSearchParam`, `peopleSearchParam`, `outdatedClientMessage`, `maxCollaborationBytes`. Safe to import anywhere        |
| `#/lib/collaboration/browser` | `CollaborativeDocuments`, which connects documents on demand; `CollaborativeFile`; the IndexedDB cache helpers `clearCollaborationCaches`, `collaborationCachePrefix`, `documentCachingStopped`, `stopDocumentCaching`; the draft cache `reconcileSourceDrafts`, `serializeSourceDrafts`, `SourceDraft` |
| `#/lib/collaboration/server`  | `collaborationAccess` (the `/api/collaboration` access check), `invalidateCollaborationAccess`, `invalidateOrganizationCollaborationAccess`, `cleanupDeletedCollaboration`, `collectCollaborationSources`. Does not load the Workers runtime, so Bun tests can import it                                |
| `#/lib/collaboration/room`    | `CollaborationRoom` (the abstract Durable Object base class) and `CollaborationEnv`. Imports `cloudflare:workers`, so only Worker code loads it                                                                                                                                                         |

The rest of the app imports the core only through these entry points. The
modules that bind it to the app, named below, are imported by path.

## Boundaries

The feature depends on `@texfolia/db` (project nodes and the
`project_collaboration` registry), `#/lib/storage` (source objects),
`#/lib/projects` (the access request type and live-access interval), and
`#/lib/editor/latex/format` (a text diff with no CodeMirror imports). It
owns `yjs`, `y-protocols`, `y-indexeddb`, and `lib0`. It does not depend on
CodeMirror; the `y-codemirror.next` binding stays in the editor route.

`CollaborationRoom` is abstract. `project-collaboration.server.ts`
subclasses it as `ProjectCollaboration`, and `src/worker.ts` exports that class, so Wrangler keeps binding `ProjectCollaboration`. The subclass
supplies what collaboration does not own:

- `lockProject` locks the project and checks access, including collaborator and
  share-link grants.
- `isAnonymous` marks share-link principals, which have no presence.
- `sourcesChanged` runs after the room persists sources (the app invalidates
  the compiler's build).

Operations that rewrite saved sources outside collaboration, such as Git, go
through the protected `withSavedSources`: it flushes dirty documents first and
reloads open documents afterward. The app's `gitAction` RPC uses it.

`collaborationAccess` takes the same lock. `CollaborativeFile` takes
`anonymous` and a `decorateUrl` hook, which the share view uses to add its
share token to the socket URL.

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
