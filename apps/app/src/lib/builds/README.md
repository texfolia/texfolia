# Project builds

Everything the product decides about a compile: who may start one, what it
contains, where its result lives, and who hears about it. The compiler Worker
(`apps/compiler`) only turns sources into artifacts. This feature calls it
through the wire in `@texfolia/contracts/compiler`.

| Module                     | Contents                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `client.ts`                | `fetchBuilds` and `buildsFetcher`, the only way other features reach a project's builds                                           |
| `project-builds.server.ts` | The `ProjectBuilds` and `CompileUsage` Durable Objects and the queue consumer                                                     |
| `coordinator.ts`           | `ProjectCoordinatorCore`: revisions, 300 ms debounce, cancellation, retries, publication, retention, and SSE                      |
| `coordinator-api.ts`       | The HTTP routes of one project                                                                                                    |
| `compiler.ts`              | Runs a build on the compiler: incremental requests, cache archives, cancellation, and per-plan priority                           |
| `limits.ts`                | Plan timeouts, rolling fair use, and submission admission                                                                         |
| `queues.ts`                | The Pro and Free overflow lanes, the dead-letter queue, and maintenance                                                           |
| `source-sync.ts`           | Source deltas, server resyncs, and snapshots                                                                                      |
| `storage.ts`               | Workers storage: artifacts in `BUILD_ARTIFACTS`, saved sources read from `SOURCES`, and drafts in the Durable Object's own SQLite |

## Sources

A build's manifest names each file by SHA-256 hash. Saved files are read from
`projects/<id>/sources/<hash>` in the app's bucket when they are compiled; they
are never copied. Submitted text that is not saved yet is a draft in the
coordinator's SQLite until no build refers to it. A server resync carries only
hashes and sizes. A saved object that disappears before its build runs fails
that build and forces the next submission to resync.

## Limits

Free and unknown plans may submit twice per ten seconds per user, run for 15
seconds, and use 180 seconds of compile time per rolling hour. Pro and Team
builds run for 300 seconds and use 600 seconds. An attempt reserves its
allowance before it starts and settles it afterwards, including failures and
cancellations. Paid builds queue ahead of Free ones for a container, and the
overflow queues run four Pro builds and one Free build at once.

A compiler failure that is not the document's fault moves the build to its
plan's overflow queue, which delivers it once, retries once, and then records a
terminal failure through the dead-letter queue.

## Checks

```sh
bun test apps/app/src/lib/builds
bun run --cwd apps/app test:compile-engine
```

The second command runs the Durable Objects in workerd against the real compiler,
Docker, and Tectonic. Build the engine image first with
`bunx turbo run build --filter=compiler`.
