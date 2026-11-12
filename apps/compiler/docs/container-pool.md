# Compiler spare pool

`POOL.getByName("global")` owns the global spare inventory. The existing five-minute cron bootstraps its alarm without traffic; claims also schedule replenishment. Alarms check health and renew unassigned spares every minute. A spare is available only after startup and `/health` succeed. Health checks do not send `X-Project-Id`, so the first compile binds the engine.

The target starts at one. A one-minute observation window with at least two misses and a miss fraction of at least 25% raises it to two. Five minutes without a new claim lowers it to one. Shrinking stops only unassigned containers. Claimed containers retain the existing ten-minute idle shutdown.

Pro claims run immediately. Free and unknown-plan claims wait 25 ms, allowing concurrent Pro requests to claim scarce spares first. Priority applies to overlapping requests in this window; completed assignments are never preempted. Free can use the last spare when no Pro claim arrives.

Each coordinator persists a claim ID before RPC and the returned container name before compiling. The pool persists each claim result and inventory removal atomically. Retrying the same claim returns the same result without incrementing counters. A stopped project container causes a new claim ID and a new allocation. Assigned names never return to the spare inventory. On a pool RPC failure the coordinator cold-starts a unique project container; a spare allocated by an ambiguous RPC failure expires unused.

`compile_pool_claim` telemetry records `jobId`, `projectId`, `plan`, `container`, and `outcome` (`hit`, `miss`, `reused`, or `error`). Compute the claim hit rate as hits / (hits + misses), excluding reused containers and RPC errors. `compile_pool` alarm events include durable hit/miss counters, target, observation-window counters, and spare state. Compile engine temperature is separate: a prewarmed process can still have a cold project cache.

## Deployment and verification

Migration `v3` adds the SQLite PoolManager DO. The existing container application remains capped at 20 instances, including spares; capacity failures leave spares unavailable and retryable. This change retains the existing container scheduling policy: Wrangler 4.156.0 rejects `durable_object` together with this application's `image`, `image_build_context`, `instance_type`, and `max_instances` settings. Switching requires a separate migration to the named-image provisioning/start API rather than changing the policy alone.

`test/pool.test.ts` exercises the production pool logic against SQLite persistence, with controlled container lifecycle calls and time. The compiler suite also checks engine project isolation. Deployment validation should confirm health/start/stop behavior and claim events in Cloudflare, then compare first-project compile latency on hits versus misses. Local tests and deployment dry runs do not establish production warm-hit rates or latency.
