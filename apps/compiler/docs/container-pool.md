# Compiler shared pool

`POOL.getByName("global")` owns the Cloudflare container inventory and exclusive
job leases. A project keeps its coordinator and durable cache archive, and leases
a container only while an engine attempt runs. The same process can serve many
projects over its lifetime.

## Claim and release

Each attempt creates a new claim ID. The pool atomically saves the claim result,
lease, and inventory removal in SQLite. Repeating an active claim returns the
same container without incrementing counters. Claims whose leases have ended
fail instead of returning a container that another job may now use.

A claim selects a healthy spare or allocates a uniquely named cold container.
The client calls `PUT /lease` with its project ID and `X-Container-Lease` token.
The token contains the container's increasing generation and the unique claim
ID. Compile, cache restore, and cancellation requests carry that token. Retired
generations and mismatched tokens cannot access a subsequent project's lease.

The engine client restores `projects/<id>/cache.tar.zst` from R2 onto the leased
container. Missing, corrupt, or unavailable archives fall back to an uncached
compile. Clean builds skip the saved archive. Each lease also receives a full
source resync from the durable mirror. The coordinator saves the next archive
after a successful build. Cache ownership is independent of container identity.

The client consumes the complete multipart result before releasing the lease,
including after a TeX error or cancellation. `DELETE /lease` cancels remaining
work and waits for it to exit. The engine removes the lease workdir, which holds
sources, build output, and the Tectonic temporary directory. It also clears the
source manifest, cancellation records, and in-memory project cache.
The process and baked LaTeX format cache remain warm. Tectonic still runs as
uid 10001 with `--untrusted` and `TECTONIC_UNTRUSTED_MODE=1`.

A resetting container stays unavailable until cleanup succeeds. Reset state
survives pool eviction, and alarms retry failed cleanup. Leases have a
15-minute crash-recovery deadline covering startup, archive restoration,
compilation, and response transfer. The client requests cancellation 90 seconds
before that deadline. An expired lease is reset before reuse. This deadline
bounds abandoned work and does not reserve a container between builds.

The pool prefers a returned process over a replacement spare started during the
job and stops surplus idle containers. A failed pool RPC uses an ephemeral cold
container, which the client destroys after the attempt. An allocation hidden by
an ambiguous RPC failure is recovered through lease expiry.

## Capacity and scheduling policies

The pool has no always-on container. The idle target starts at zero, so a new
or idle pool runs no containers. The first compile allocates a cold container.
When its lease is released, the target rises to one and the returned process
stays as the warm spare. A one-minute window with at least two misses and a miss
fraction of at least 25% raises the target to two. Five minutes without a new
claim lowers it from two to one. Shrinking stops only idle containers. The
container application remains capped at 20 instances, including idle spares.

The pool is active while a compile has claimed a container in the last 10
minutes (`poolIdleMs`) or an editor has reported presence in that window. An
editor reports presence when its `GET /projects/<id>/events` stream attaches and
every minute while it stays open. When neither signal has been seen for 10
minutes, maintenance sets the target to zero and stops every spare. Presence
only delays this. It does not start a container, so opening an editor on an
idle pool does not pre-warm one. The next compile is a cold start. Raising the
target in `PoolCore.touch()` would add editor-open pre-warming.

Claims, releases, and leases schedule the pool alarm. While spares or leases
exist, the alarm runs every minute to check spare health and recover expired
leases. A spare is available only after startup and `/health` succeed. Once the
target is zero and no spares or leases remain, the alarm deletes itself. A
later claim schedules it again. The five-minute cron only enqueues legacy job
recovery and no longer wakes the pool, so neither the cron nor health checks
keep a container running when nobody is active.

Pro and Team claims run immediately. Free and unknown-plan claims wait 25 ms,
allowing overlapping Pro or Team requests to claim scarce spares first.
Running compiles are never preempted. The normal compile path remains direct.
`compile-pro` and `compile-free` remain infrastructure-failure recovery queues.
Revised pool sizing and priority policies remain follow-up work.

Local Docker uses the same pool and engine client. Inventory, generations, and
leases persist in `<COMPILER_DB_PATH>.pool.sqlite`. A one-minute timer performs
maintenance while the API runs. Idle containers keep their identities across
API restarts. The isolated `localProjectEngine` helper remains only for historical
cold-start measurements, outside the application compile path.

## Telemetry and rollout

`compile_pool_claim` records `jobId`, `projectId`, `plan`, `container`, and
`outcome`, which is `hit`, `miss`, or `error`. A hit means the attempt claimed an
available spare, including a container returned by a previous job. Historical
`reused` events belong to the dedicated-container model. The claim hit rate is
hits / (hits + misses), excluding RPC errors. `compile_pool` alarm events include
counters, target, observation-window counters, spare state, and active leases.
A warm process can still need a project archive restore.

The existing `v3` PoolManager namespace and container scheduling policy remain.
Pool state upgrades to version 2 with an empty lease list. Old unassigned spares
are marked for shutdown before reuse because their images may lack lease endpoints.
Before claiming or preparing shared capacity, each coordinator destroys its old
assigned container and drops the assignment table. This frees capacity under the
existing instance cap. Old dedicated containers for projects that remain unopened
expire under the previous idle timeouts. The pool does not adopt them. Rebuild and deploy the engine image together with
the Worker so the lease endpoints are available. Local upgrades also require
removing old `texfolia-project-<projectId>` containers.

`test/pool.test.ts` exercises SQLite persistence with controlled lifecycle calls
and time. `test/pooled-engine.test.ts` checks client handoff and response lifetime.
Go lease tests exercise real HTTP handlers, process cancellation, workdir cleanup,
cache restore, and stale-token rejection. `scripts/verify-pooled-engine.ts` checks
real Tectonic PDFs across project handoffs and a local adapter restart.
Production rollout still requires checking Cloudflare start, destroy, and alarm
behavior. Local results do not establish production hit rates or latency.
