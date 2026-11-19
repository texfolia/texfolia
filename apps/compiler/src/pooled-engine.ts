import { poolLeaseMs, type PoolClaim } from "./pool";
import { createProjectEngineClient } from "./project-engine";
import { emitCompileEvent } from "./telemetry";
import type { Engine, ObjectStore } from "./types";

export function createPooledEngine(options: {
  projectId: string;
  store: ObjectStore;
  claim: (
    plan: Parameters<Engine>[1]["plan"],
    claimId: string,
  ) => Promise<PoolClaim>;
  release: (claimId: string) => Promise<void>;
  fetch: (container: string, request: Request) => Promise<Response>;
  discard: (container: string) => Promise<void>;
  prewarm: () => Promise<void>;
}): Engine {
  const compile: Engine = async (project, context) => {
    context.signal?.throwIfAborted();
    const claimId = crypto.randomUUID();
    let claim: PoolClaim;
    let pooled = true;
    try {
      claim = await options.claim(context.plan, claimId);
    } catch (error) {
      console.error("Container pool claim failed", {
        projectId: options.projectId,
        error,
      });
      pooled = false;
      claim = {
        container: `fallback:${claimId}`,
        generation: 1,
        outcome: "miss",
      };
    }
    const token = `${claim.generation}:${claimId}`;
    const fetch = (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("X-Container-Lease", token);
      return options.fetch(claim.container, new Request(request, { headers }));
    };
    emitCompileEvent({
      event: "compile_pool_claim",
      projectId: options.projectId,
      jobId: context.jobId,
      plan: context.plan,
      outcome: pooled ? claim.outcome : "error",
      container: claim.container,
    });
    try {
      context.signal?.throwIfAborted();
      let acquiring: Promise<void> | undefined;
      const engine = createProjectEngineClient({
        projectId: options.projectId,
        store: options.store,
        fetch: async (request) => {
          // Include container startup and lease acquisition in preparation timing.
          acquiring ??= fetch(
            new Request("http://container/lease", {
              method: "PUT",
              headers: { "X-Project-Id": options.projectId },
              signal: AbortSignal.timeout(90_000),
            }),
          ).then(async (response) => {
            await response.body?.cancel();
            if (!response.ok)
              throw new Error(`Container lease failed (${response.status})`);
          });
          await acquiring;
          return fetch(request);
        },
      });
      return await engine(project, {
        ...context,
        projectId: options.projectId,
        signal: AbortSignal.any([
          ...(context.signal ? [context.signal] : []),
          AbortSignal.timeout(poolLeaseMs - 90_000),
        ]),
      });
    } finally {
      // Engine clients consume the entire multipart response before returning.
      // Failed cleanup leaves a durable resetting lease for the pool alarm.
      try {
        if (pooled) await options.release(claimId);
        else await options.discard(claim.container);
      } catch (error) {
        console.error("Container lease cleanup failed", {
          container: claim.container,
          claimId,
          error,
        });
      }
    }
  };
  // Editor connections replenish shared capacity without reserving it.
  compile.prewarm = options.prewarm;
  return compile;
}
