# Cold starts and editor prewarm

Editor attachment now starts and restores the project's own container before
compilation is requested. A warm process keeps its generated-file cache in
memory. A fresh process restores that cache with one object-store read.
Cloudflare now selects a persisted PoolManager assignment, which can claim a
ready spare. Project cache restoration still happens separately. No container
snapshots are used. The November 12 local measurements below predate the pool
and do not measure spare claims. See [Container pool](docs/container-pool.md).

## Actual path

1. The authenticated editor attaches to the coordinator's SSE endpoint. The
   coordinator returns its current snapshot immediately and starts preparation
   as background work. The Durable Object retains the preparation with
   `ctx.waitUntil`.
2. On Cloudflare, the coordinator selects its persisted container assignment
   from PoolManager, reassigning a stopped container. The engine client requests
   `/health` on that assigned container. The installed
   Containers SDK starts a stopped container and waits for its port before
   forwarding that request. The image starts the static Go binary, checks
   Tectonic availability, and listens on port 8080. Image construction has
   already warmed the base LaTeX format.
3. If that process has no cache yet, the client reads
   `projects/<id>/cache.tar.zst` once and sends it to `PUT /cache`. The engine
   validates and unpacks the bounded archive into its in-memory project cache.
   Repeated preparation on the same ready process does not read the archive.
4. On a compile, source objects download concurrently with archive fetch/unpack
   once the health response arrives. A compile that overtakes editor prewarm
   shares the same preparation. Source deltas still resync on a missing engine
   working copy. Prewarm itself does not compile TeX or download project sources.
5. Tectonic receives the current sources and cached auxiliaries, with real
   sources taking priority. A clean build bypasses the cache. A cached TeX
   failure retries once clean; a failure known not to have used cache does not.
6. A successful engine run retains the new cache and creates its next archive.
   The multipart response sends the PDF first, then the log, archive, and other
   artifacts. The coordinator saves the immutable download generation, replaces
   the archive, saves the result, and publishes the manifest over SSE. A failed
   write keeps the previously published generation visible.

Missing archives, including projects built before this change, compile without
restored auxiliaries. Corrupt or unavailable archives also degrade to an
uncached compile; no per-file restore fallback remains. The archive excludes
the primary PDF, but includes logs, auxiliaries, SyncTeX, and custom outputs.
It does not snapshot the container or its Tectonic package/font download cache.
That cache starts with the packages present in the image's base-format warmup.

Cloudflare containers sleep after 10 minutes without proxied activity for Free
or 30 minutes for Pro and Team. SSE heartbeats do not ping them. If an editor stays open longer without compiling, its
next compile can therefore be cold again. Clearing/deleting the build or the
30-day retention cleanup removes the archive along with the other project
objects; the next compile bypasses any still-resident cache.

## Telemetry definitions

These optional fields travel through engine-request and backend compile events
and persisted job timings. Older records remain valid.

| Field              | Meaning                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `containerStartMs` | Wall time for readiness, including binding/transport, VM/container startup if required, and health response. On an already running process this is a health round trip, not zero.                            |
| `containerBootId`  | Random identity for this Go process, used to avoid attributing an old prewarm to a newer boot.                                                                                                               |
| `bootMs`           | Go process initialization through Tectonic availability check and handler creation. Excludes scheduling, VM startup, and image pulling.                                                                      |
| `imageSizeBytes`   | Baked, uncompressed root-filesystem allocated bytes measured by `du -sx --block-size=1 /` at image build. Not registry transfer size or total OCI layer size. Null for binaries without that build metadata. |
| `archiveFetchMs`   | Complete object-store read, including consumption of the archive body. Zero when no read was needed.                                                                                                         |
| `archiveUnpackMs`  | Engine-side archive request-body read, zstd decoding, and tar validation. Includes receipt of the uploaded bytes; excludes the Worker's R2 read.                                                             |
| `archiveBytes`     | Compressed object size, or zero if missing/unavailable/already warm.                                                                                                                                         |
| `archiveStatus`    | `restored`, `missing`, `invalid`, `unavailable`, or `warm` when the engine cache was already initialized.                                                                                                    |
| `prewarmed`        | The first compile consumed completed editor-prewarm measurements from the same process boot. This does not prove a particular amount of editor dwell time.                                                   |
| `cacheUsed`        | Whether the engine actually supplied auxiliaries to this compile, including clean-retry bypass.                                                                                                              |

Prewarm startup measurements describe work done before the first compile, not
extra duration inside `engineRequestMs`. Subsequent compiles report their own
health check and `warm` archive status. The existing `temperature` still counts
first versus subsequent TeX runs in a process: the first TeX run can say `cold`
even when editor prewarm already restored the cache. Use `archiveStatus`,
`cacheUsed`, and `prewarmed` together rather than treating `temperature` as a
container-readiness measurement.

## Historical local measurements, November 12, 2026 UTC

This measures the real Docker/Go/Tectonic path with the SQLite coordinator and
object store. It does **not** measure Cloudflare VM provisioning, R2 network
latency, browser rendering, or production editor dwell time.

The decision being checked was whether startup/restore can move before the
compile action without skipping cache restoration or TeX work. This is not an
estimate of an overall keystroke-to-PDF speedup. One excluded seed build created
the archive; five alternating pairs then removed and recreated the project's
container for every sample. The image was already local, but each container's
writable filesystem and working copy were fresh. The Tectonic binary is 0.15.0,
running as linux/amd64 under Docker Desktop on an ARM64 host, with one CPU and
1 GiB of memory. The fixture has a table of contents and 27 numbered sections
with cross-references. Its content-addressed source is downloaded from SQLite.

The compile-triggered cohort disables editor prewarm only in the harness. The
editor-prewarmed cohort waits for editor preparation to finish before starting
the compile clock. Both use identical sources, restored cache, debounce, engine,
artifact persistence, PDF streaming, and SSE completion. This measures the work
that editor dwell time **can** hide, not work eliminated from editor-open time.

Values are medians with observed minimum–maximum in milliseconds, five samples
per cohort:

| Stage                                    |         Compile-triggered |                       Editor-prewarmed |
| ---------------------------------------- | ------------------------: | -------------------------------------: |
| Readiness, recorded on the first compile |    207.69 (202.43–228.92) | 183.02 (178.47–193.30), before compile |
| Process boot                             |       11.55 (11.35–11.95) |                    12.13 (11.57–13.91) |
| SQLite archive read                      |          0.15 (0.12–0.34) |       0.11 (0.09–0.14), before compile |
| Engine archive unpack                    |          3.79 (3.68–3.96) |       3.73 (3.56–3.81), before compile |
| Editor preparation before compile clock  |                  Disabled |                 188.30 (183.58–198.50) |
| TeX run                                  |  1085.49 (997.05–1165.77) |               1044.81 (986.37–1134.01) |
| Compile action to first PDF bytes        | 1616.79 (1547.40–1689.22) |              1373.42 (1315.88–1463.56) |
| Compile action to saved SSE completion   | 1619.91 (1550.87–1692.76) |              1376.74 (1319.16–1466.96) |

Every measured compile performed exactly one archive read and no reads from
the immutable build-generation prefix. Every one used its restored cache,
performed zero TeX reruns, and produced a 12,887-byte PDF. All 11 PDFs, including
the seed, passed text extraction checks for the expected content and the resolved
Section 27 reference. There were zero failed compiles. Archives were
5,779–5,781 bytes. The image reported `imageSizeBytes = 188,809,216`.
The measured image ID was
`sha256:41189fc5744e86f025adb222f24e2be842454557cf4994f1e8136f988cf0dc0b`.

The remaining latency is not pure startup: both cohorts pay the coordinator's
roughly 300 ms debounce and a roughly one-second TeX run. Cgroup counters for
the prewarmed runs recorded 559.21–593.84 ms of CPU consumption around each
compile, with a one-CPU quota. Engine logs show fresh downloads of `SHA256SUM`
and three Latin Modern fonts on every new container. Thus neither cache restore
nor CPU saturation alone explains the remaining wall time. These runs establish
the moved startup boundary and cache reuse, not a production throughput claim
or a sub-second first compile. The prewarm savings are bounded by startup/restore
work and how long the user leaves the editor open before compiling.

### Reproduce

From the repository root, with Docker and Go available:

```sh
docker build --platform linux/amd64 -f apps/compiler/Dockerfile -t texfolia-latex-engine:nat239 .
RESULT_DIR=/private/tmp/nat239-cold-starts PAIRS=5 bun apps/compiler/scripts/cold-starts.ts
```

The harness uses the real local container adapter, persists the seed cache,
alternates the two cohorts, reads completion through SSE, verifies successful
PDF responses and actual cache-use telemetry, records archive-read counts and
cgroup CPU counters, and removes only its own project container. It writes
`results.json`, the SQLite database, and every PDF to `RESULT_DIR`.

The original run's artifacts are in
`/private/tmp/nat239-cold-starts-verified/`. Its PDF content check was:

```sh
for file in /private/tmp/nat239-cold-starts-verified/*.pdf; do
  pdftotext "$file" - | rg -q 'Cold start verification\. See Section 27\.' || exit 1
done
```

### Production validation still required

No production deployment or Cloudflare cold-start benchmark was performed for
this change. The issue's approximate 1–3 second container-start context is not a
new measurement. After deployment, compare real editor-open/first-compile
cohorts, count successful `restored` versus `warm` versus missing/error archive
statuses, and inspect `containerStartMs`, `bootMs`, and `imageSizeBytes` together.
Confirm exactly one `cache.tar.zst` GET per restored process, no per-artifact
cache GETs, and published PDFs across a real 10-minute sleep. Production R2
fetch/unpack distributions and whether editors **usually** hide cold startup
remain unverified here.
