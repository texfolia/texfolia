---
title: Multiple compile engine plan
---

This is a proposed implementation plan for [NAT-316](https://linear.app/nbaby/issue/NAT-316/plan-multiple-compile-engine-options),
reviewed against `main` at `7a8482d` on November 16, 2026. It does not add engine
support. The running compiler supports only the patched Tectonic image.

NAT-316 remains post-v1 and Low priority. Its work order follows NAT-320,
NAT-198, NAT-318, NAT-299, and NAT-302. This plan does not declare those issues
complete. The larger-instance tier in NAT-235 stays canceled. Container instance
size, billing multipliers, and an Auto mode are outside the accepted scope.

The proposed backend carries one resolved engine target through each build,
separates caches by compile mode and toolchain, and reports the driver that ran.
The image layout and user-facing selection remain decisions for review.

## Decisions still open

These choices need a recorded decision in NAT-316 before their implementation.
The proposals below do not settle them.

| Decision        | Choices to resolve                                                                                                                                                              | What depends on it                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Engines to ship | Whether to retain Tectonic and which, if any, TeX Live modes or other engines to add. The issue names pdfLaTeX, XeLaTeX, and LuaLaTeX through latexmk as candidates.            | Supported engine IDs, Go drivers, packages, compatibility fixtures, and release scope. |
| Selection scope | Whether engine choice belongs to a project, an individual compile, or another scope. Decide the default and what happens when a project is copied or imported.                  | Persistence, authorization, request construction, and stale-build behavior.            |
| Selection UI    | Where users choose an engine and how unsupported selections appear. The canceled NAT-206 status-bar picker, project settings, Auto mode, and cost multipliers are not approved. | UI design, accessibility checks, and user documentation.                               |
| Image budget    | The accepted package and font coverage, image size budget, and one image versus separate images. No size estimate has been measured for this work.                              | Docker targets, pool routing, deployment configuration, and rollout checks.            |

The engine and image decisions gate a second engine release. Selection scope and
UI decisions gate user-facing selection. A Tectonic-only backend refactor can be
reviewed separately after agreement on the contracts below, but does not satisfy
NAT-316's multiple-engine acceptance criteria.

## Current compile path

The authenticated [web compile route](../../../../app/src/lib/compile/compile-route.server.ts)
checks project access, reserves a job using `compileRequestDigest`, reconciles
sources, and forwards the request to the private compiler. Its digest includes
the submitted source delta and clean-build flag, but no engine choice.

The [coordinator API](../../../../app/src/lib/builds/coordinator-api.ts) accepts
either a snapshot or a source delta.
[ProjectCoordinatorCore](../../../../app/src/lib/builds/coordinator.ts)
persists the build, serializes revisions, cancels superseded work, and recovers
pending attempts after a restart. Neither the saved build nor the `Engine`
context in [types.ts](../../../../app/src/lib/builds/types.ts) identifies a selected
engine. The schemas in [source-sync.ts](../../../../app/src/lib/builds/source-sync.ts)
also have no engine field. Adding an unchecked field to a source body would not
carry a selection through these parsers.

Each attempt uses the [compiler client](../../../../app/src/lib/builds/compiler.ts) to
send one archive to the compiler Worker. The Worker leases a container, streams the
archive to it, and returns the response archive as it arrives. A container keeps
one caller's sources and cache between compiles and wipes them before it serves
another caller. The wire in
[contracts](../../../../../packages/contracts/src/compiler.ts) has no engine field.

The [Go runner](../../../../compiler/engine/compile.go) invokes `tectonic` directly.
Its cache placement and environment are Tectonic-specific.
[main.go](../../../../compiler/engine/main.go) checks Tectonic at startup, and
[handler.go](../../../../compiler/engine/handler.go) labels attempt timing as
`tectonic`. The [Dockerfile](../../../../compiler/Dockerfile)
builds patched Tectonic and biber, warms formats and common packages, and installs
Poppler. It installs neither TeX Live nor latexmk.

Cache reuse spans several owners:

- The coordinator checks `manifest?.engine === "tectonic"` and one project-wide
  `cacheValid` flag before allowing reuse.
- The compiler client restores `projects/<projectId>/cache.tar.zst`. A successful build overwrites that same
  archive, regardless of engine.
- The Go engine keeps one cache map and a `cacheReady` boolean per slot.
  Neither identifies an engine. [cache.go](../../../../compiler/engine/cache.go)
  validates archive paths, entry types, and size limits, but no engine identity.
- The [artifact manifest](../../../../app/src/lib/builds/artifacts.ts) records the engine
  family from output timing. It describes downloadable build files, rather than
  independently tracking caches for several engines.

The [Worker](../../../../compiler/worker.ts) uses `POOL.getByName("autoscaler")` and one
`COMPILER` container binding. [Wrangler configuration](../../../../compiler/wrangler.jsonc)
maps `TectonicContainer` to the Dockerfile, with `basic` instances and a cap of 20.
The [local pool](../../../../compiler/src/local-containers.ts) also uses one image,
configured through `ENGINE_IMAGE` in [index.ts](../../../../compiler/src/index.ts).

## Proposed engine contract

### Separate selection from execution

Use an explicit engine ID for each supported compile mode. A distribution name
alone cannot distinguish pdfLaTeX, XeLaTeX, and LuaLaTeX caches or diagnostics.
Candidate IDs such as `tectonic`, `texlive-pdflatex`, `texlive-xelatex`, and
`texlive-lualatex` illustrate the distinction. They are not an approved release
list.

Add a compiler-owned engine registry in `apps/compiler/src/compile-target.ts`.
It resolves an allowed engine ID to its image target and cache compatibility
version. The registry contains only engines installed in the deployed images.
Resolve and validate a selection before accepting a build or claiming a lease.
The browser supplies no executable, command arguments, image name, or cache
version.

The proposed data contract has these responsibilities:

| Value          | Owner and meaning                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `engineId`     | The validated compile mode requested by the caller.                                                                                     |
| `cacheVersion` | A build-generated compatibility fingerprint of the engine toolchain, package and font set, fixed command recipe, and cache layout.      |
| `target`       | The pair of `engineId` and `cacheVersion`, resolved by the compiler and persisted with the accepted build.                              |
| `actualTarget` | The Go runner's identity, returned on success and after a started command fails. It must match the persisted target before publication. |

The TypeScript schema owns request validation and inferred internal types. Go
validates the same wire contract at its HTTP boundary. Shared protocol fixtures
cover valid IDs, omitted legacy selections, and invalid selections in both
languages. Neither side accepts `unknown` as a selectable engine.

Keep the existing TypeScript `Engine` callable as the transport contract. Add
the resolved target to its context and require actual identity on a new-protocol
response. The registry supplies routing data, while `createPooledEngine` retains
lease ownership. This avoids a second orchestration layer beside the coordinator.

### Keep command differences in Go drivers

Extract engine-specific steps from `compile.go` into a small driver selected by
the validated engine ID. Driver responsibilities are command construction, a
bounded environment, cache placement, and output locations. Keep workspace,
timeout, and output handling shared, with the multipart protocol in `main.go`.
Keep the Tectonic auxiliary-copy behavior and patched bibliography cache in the
Tectonic driver. Do not impose those details on another engine.

If TeX Live modes are approved, a latexmk driver selects a fixed mode and preserves
the common PDF, log, generated files, cache archive, and SyncTeX result contract.
The upstream [latexmk manual](https://mirrors.mit.edu/CTAN/support/latexmk/latexmk.pdf)
documents `-pdf`, `-pdfxe`, and `-pdflua` for the candidate modes. It also documents
`-norc`, which disables automatic initialization files. Project-provided latexmk
configuration must not become executable server configuration.

Each new driver needs an explicit untrusted-input policy equivalent to the
current isolation contract. That includes fixed commands, disabled shell escape,
bounded file access, and lease-local writable caches and temporary directories.
For latexmk and its helper processes, cancellation must stop and reap the whole
process group before lease release. A parent-only timeout is insufficient.
Real-image checks must exercise these behaviors, including any approved Lua mode.

Keep existing source, output, PDF, log, and timeout limits. Preserve PDF-first
streaming, optional Poppler previews, failure logs, and generation-bound SyncTeX
artifacts. The recently added [SyncTeX reader](../../../../app/src/lib/editor/latex/synctex.ts)
needs fixtures from every supported mode, including nested main files.

### Freeze selection for each build

Persist the resolved target in the coordinator's build record before returning
acceptance. Every source resync, clean retry, queue recovery, and restart uses
that saved target. A later project-setting change must not change an already
accepted attempt. An unavailable target fails explicitly instead of silently
running another engine.

Include the engine selection in the web request digest and coordinator submission
identity. Reusing a compilation ID for different sources or a different selected
engine returns `409`. An exact retry retains the already resolved target across
a deployment. Include the resolved target in build freshness comparisons while
keeping content hashes usable across engines.

For old requests and saved jobs without selection metadata, preserve Tectonic
behavior through an explicit legacy migration. An unknown or unsupported ID
must never take that fallback. Record the chosen default for new requests in the
selection decision. If selection becomes a project setting, also define its
membership checks, copy and import behavior, and how changes mark output stale.

## Proposed cache isolation and migration

Cache ownership must be independent of the latest displayed artifact manifest.
A successful compile with engine B must not erase the compatible cache from
engine A. Returning to A may reuse A's cache, never B's.

Use a cache identity computed from a canonical encoding of `engineId`,
`cacheVersion`, and `mainFile`. The source revision is excluded so incremental
reuse survives edits. Each identity points to an immutable archive generation:

```text
identity = SHA-256(canonical({ engineId, cacheVersion, mainFile }))
archive  = projects/<projectId>/caches/v1/<identity>/<generation>.tar.zst
```

Persist a map of cache identities to archive keys and validity in coordinator
state. Publish a new cache reference only after its archive and downloadable
artifacts are saved. A failed save or superseded result keeps the previous
references. Reuse no longer depends on `manifest.engine` or one `cacheValid`
boolean. Prune replaced archives and obsolete compatibility versions through
project maintenance, and include the new prefix in deletion and retention.

Pass the exact cache reference into `createProjectEngineClient`. It must not
reconstruct a project-wide archive path. Bind the Go lease to the resolved target
and expected cache identity. Send that identity on restore and compile requests.
Tag the archive format with its cache identity and validate it against the lease
before restoring files. Track the identity with the in-memory cache too. A
`cacheReady` value for another identity is not a hit. Keep the existing archive
path, type, and size checks when adding metadata.

A missing, corrupt, incompatible, or unavailable archive produces a clean compile
with a recorded cache outcome. `X-Clean-Build` bypasses and invalidates the
selected identity. The existing single clean retry after a cached TeX failure
retains the engine and invalidates only that cache. Neither operation invalidates
other engines' caches.

Migrate old coordinator state to an empty cache map. Do not infer compatibility
from the old `engine: "tectonic"` label, which has no toolchain or layout version.
Do not restore `projects/<projectId>/cache.tar.zst` under the new protocol.
The first successful build creates a tagged archive. Old PDFs and generated
files remain readable. Maintenance can remove the obsolete archive after the
deployment has moved to the new protocol.

## Proposed telemetry

Telemetry currently records `engine: "tectonic" | "unknown"` in
[build telemetry](../../../../app/src/lib/builds/telemetry.ts) and the web timing parser.
Older records that say `texlive` parse as `unknown` (NAT-381). Restore a
`texlive` value only when a TeX Live mode actually ships. Add `engineId` and
`cacheVersion` to distinguish actual compile modes and toolchains. Old timing
records can omit those fields.

Set actual identity from the selected Go driver when its command starts. Return
it through `X-Compile-Timing`, structured engine logs, engine errors, backend
timing, and artifact metadata. A validation, lease, or startup failure before any
command runs reports actual engine `unknown`. Record the requested engine ID
separately. Never fill actual timing from the requested target merely because it
was requested. Reject a response whose actual target differs from the saved
target, and publish neither its artifacts nor its cache.

Carry these fields through successful and failed job results and
browser preview reports. Emit selected image and target on pool claims to
diagnose routing failures. If one process serves several modes, track warmness
per mode. Extend [compile telemetry documentation](/compile-telemetry/) so
queries distinguish modes and cache compatibility versions without reinterpreting
historical `engine` values.

## Image options to review

Two image layouts fit the proposed contract. Neither is selected by this plan.

| Layout                                | Required implementation                                                                                                                                                                       | Tradeoff to validate                                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One combined image                    | Install every approved engine in one runtime. Keep one image binding and pool, advertise installed modes, and select a Go driver per lease.                                                   | Every container carries the combined package set. Measure the built image and startup behavior against the agreed budget.              |
| Separate Tectonic and TeX Live images | Keep the patched Tectonic runtime. Add a TeX Live runtime with latexmk, its runtime dependencies, the approved engines and packages, required helper tools, Poppler, and the same Go service. | Tectonic avoids carrying the TeX Live installation, but routing and capacity must cover multiple images. Measure both before choosing. |

A TeX Live image needs pinned package and font inputs and a recorded package list.
Using `texlive-full` without a coverage and size decision is not part of this
plan. The toolchain manifest supplies cache compatibility versions and advertised
capabilities. Startup checks verify the advertised binaries. The health response
identifies the image build and available targets so a client can reject the wrong
image before restoring a cache or starting a command.

If separate images are chosen, partition pool inventory by image build, while
allowing modes installed in the same image to share capacity. A claim, release,
reset, prewarm, and ephemeral fallback must all route to the same image. Worker
and local Docker adapters need the same registry mapping. Existing containers
from an older image must drain or be destroyed before reuse with a new build.

For Cloudflare, this requires image bindings, container configuration, and any
additive Durable Object class migration for the new image. Preserve the existing
`TectonicContainer` identity during that migration. For local development, replace
the single `ENGINE_IMAGE` assumption with explicit image mappings and build
commands, and cover the standalone `ENGINE_URL` verification path too. Regenerate binding types
after the configuration changes.

Keep the current `basic` instance size. Do not multiply the current 20-instance
capacity allowance when adding image applications. The chosen deployment needs
an explicit combined capacity allocation and spare policy. This is engine routing
work, not a larger-instance compile tier.

Record compressed image size separately from the existing `imageSizeBytes`
telemetry, which the Dockerfile derives from an in-image `du` measurement.
Record package coverage and the measurement method beside any image-budget
decision. No image size or compile-speed claim follows from this plan.

A candidate-image spike belongs to the image decision. It produces package lists,
image sizes, and startup observations for review before production drivers and
routing ship. Building an evaluation image does not approve its engines for
release.

## Implementation sequence and acceptance evidence

Each stage needs the preceding decisions or contracts before it starts. Backend
work can land with Tectonic as the only enabled target. Additional engines remain
unavailable to callers until their images and verification are ready.

| Stage                              | Reviewable change                                                                                                                                                              | Required evidence                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Record decisions                | Resolve the engine set, selection scope, UI, and image budget in NAT-316. Confirm this plan's proposed contracts.                                                              | A supported-engine list, defaults, selection rules, package coverage, and an image decision with measurements.                                                                                                 |
| 2. Carry target identity           | Add the registry and protocol fixtures. Persist targets, update request identities, and propagate them through coordinator, transport, and Go. Extract the Tectonic driver.    | Existing Tectonic behavior passes. Unknown targets fail before allocation. Different-engine retries conflict. Saved targets survive recovery and source resync.                                                |
| 3. Isolate caches                  | Add versioned, tagged cache archives, per-identity state, immutable publication, and cold migration.                                                                           | Tests prove isolation between modes, toolchain versions, main files, and projects. Clean retry, failed publication, and cancellation preserve the correct references.                                          |
| 4. Add approved engines and images | Implement the approved drivers, image recipes, health capabilities, and local and Worker routing.                                                                              | Real-image compiles produce valid PDFs, logs, auxiliaries, SyncTeX, and opt-in previews. Timeouts reap helper processes. Every pool lifecycle path uses the intended image.                                    |
| 5. Expose selection                | Implement the agreed persistence and UI, including defaults, unsupported selections, and project access checks.                                                                | A user can select each supported mode and compile. Selection survives exactly the scope agreed in stage 1. Existing projects keep their migration default.                                                     |
| 6. Roll out and document           | Deploy matching images and Worker protocol, drain incompatible inventory, then enable the approved choices. Update compiler setup, API, cache, pool, telemetry, and user docs. | Deployed attempts report actual modes, separate caches, and correct images under existing instance limits. Disable new selection during rollback. Never substitute Tectonic for an unavailable requested mode. |

Extend the existing suites rather than testing only registry lookups:

- [builds.test.ts](../../../../app/src/lib/builds/builds.test.ts) and
  [coordinator.test.ts](../../../../app/src/lib/builds/coordinator.test.ts) need A-to-B-to-A
  cache reuse, engine-only freshness changes, restart and queue recovery, and
  same-ID engine conflicts. A failed B build must retain A's successful PDF and
  cache while reporting B's failure log and actual engine.
- [compiler.test.ts](../../../../app/src/lib/builds/compiler.test.ts),
  [compile.test.ts](../../../../compiler/test/compile.test.ts), and the pool suites need
  tagged restore, wrong-image rejection, actual-identity mismatch, clean retry,
  fallback routing, and handoff between projects and modes.
- The [Go tests](../../../../compiler/engine) need real driver output and cancellation,
  archive identity checks, path-policy checks, and lease cleanup. The web compile
  route needs request-digest and timing-parser coverage for each approved mode.
- Add `apps/compiler/scripts/verify-compile-engines.ts` to drive the built images
  with the same article, bibliography, nested-main, generated-file, and SyncTeX
  fixtures. Exercise clean and cached runs, mode switches, corrupt archives,
  helper-process cancellation, and project handoffs. Record actual identities and
  inspect saved cache keys, rather than accepting mocked timing as proof.

During implementation, run the affected compiler and web tests, Go race tests,
type checks, formatting checks, and the real-image script. Verify Cloudflare
image routing, lease reset, and capacity separately from local Docker results.

NAT-316 is complete only when selected-engine execution works in Go and the
coordinator, actual-engine telemetry is accurate, cache restore is isolated, the
chosen images run the supported modes, and the docs describe that shipped set.
This planning document alone meets none of those runtime acceptance criteria.
