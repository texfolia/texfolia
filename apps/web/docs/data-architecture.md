# Application data ownership

The authenticated workspace uses TanStack DB for project metadata, file structure,
and browser preferences. Collections own persisted state; React owns dialog
visibility, form input, editor buffers, tabs, diagnostics, and compilation state.

## Callers

```tsx
const store = useProjects();
const { data: projects } = useLiveQuery(store.projects);
const projectId = await store.create("Thesis");
await store.remove(projectId);

const { data: nodes } = useLiveQuery(files.nodes);
await files.create({ parentId: folder.id, name: "chapter.tex", kind: "text" });

const { editor, updateEditor } = useSettings();
updateEditor({ ...editor, fontSize: 16 });
```

## Boundaries

- `features/projects/server.ts` authenticates requests and persists PostgreSQL
  transactions. Project creation includes its root folder and `main.tex`. Node
  creation verifies the owner's active project and a live folder in that project.
  Database constraints enforce unique sibling names. The project lock orders node
  creation against project deletion.
- `features/projects/collections.ts` owns project and file actions. It allocates
  UUIDs before insertion, constructs optimistic rows, and awaits transaction
  settlement before navigation or opening a new editor. Types derive from the
  server's inferred read models rather than duplicate database columns.
- `data/rpc-collection.ts` adapts route snapshots and single-row server commands
  to TanStack DB. Successful responses enter the sync layer before the optimistic
  transaction settles. Failed commands roll back. It does not poll or claim
  real-time synchronization with other clients.
- Route loaders create collections for the current user or project. They fetch
  fresh snapshots on navigation; collections never live in a Worker singleton.
  Routes using DB set `ssr: false`, as required by the installed DB guidance.
  Public pages retain SSR.
- `features/projects/workspace.tsx` owns editing and compilation. Routes own auth,
  loading, and composition. `paths.ts` gives the tree, analysis, and compiler the
  same file paths.
- `features/settings/collection.ts` uses the built-in local-storage adapter for
  editor and formatting preferences. It validates stored rows, migrates the old
  `texfolia.editor` and `texfolia.format` values once, and synchronizes active
  consumers and tabs. Storage write failures reject and roll back the change.
  If browser storage access is denied, preferences work in memory with a visible
  warning. The settings provider releases the collection and listeners on unmount.
- `hooks/use-settings.tsx` binds preferences to React and owns settings navigation
  and keyboard shortcuts. Components do not read or write preference storage.

This concentrates persistence behind small feature actions, following boundary
discipline and single ownership. The generic adapter handles acknowledgements;
feature modules retain the rules for constructing projects and nodes. No second
query cache or component-level copy of persisted rows is required.

## Design decision

Two shapes were compared before implementation:

1. **An application-wide query-backed database.** This provides a shared cache
   across routes but adds Query Client ownership, user-session eviction, and
   invalidation across project details and lists. Those responsibilities are
   unnecessary for the current snapshot-based backend.
2. **Route-owned collections with acknowledged commands.** This keeps session and
   project isolation explicit and uses the existing server functions. It is the
   selected base. Browser preferences adopt the first design's useful shared
   persistence behavior through the local-storage adapter.

The comparison favored correct rollback, isolation, one persistence owner, and
the smallest caller API. The architect skill's configured Claude and Grok runners
were unavailable, so the alternatives were compared directly without a separate
model judge.

We accept refetching on navigation in exchange for avoiding a second cache and
cross-route reconciliation. Bulk commands require their own transactional server
endpoint; the adapter rejects multi-row mutations before sending any writes.
Offline queuing and collaborative document synchronization require a different
backend contract and are not implied by an optimistic collection.

## Source content and verification

File creation persists the file's identity and tree position on the server. Source
text retains the existing browser-local save behavior under
`texfolia.project.<projectId>.sources`. Editor keystrokes remain editor state;
moving them into metadata collections would not provide document persistence.

`bun test` verifies live queries, canonical acknowledgements, rejection rollback,
route isolation, nested file paths, preference migration, synchronization, and storage failures.
`bun run lint` enforces import boundaries between UI, feature data, and the RPC adapter.
`bun run typecheck` checks callers against server inference. `bun run build`
checks the Start client/server split. A connected database and authenticated
session are still needed to exercise the complete RPC flow end to end.
