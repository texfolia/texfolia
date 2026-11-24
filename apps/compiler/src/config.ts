import { Context, Effect, Layer, Schema } from "effect";

const integer = (fallback: number, minimum: number, maximum: number) =>
  Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum, maximum }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(String(fallback))));

// Each variable is optional. wrangler.jsonc sets the deployed values.
const Variables = Schema.Struct({
  POOL_MIN_WARM: integer(0, 0, 100),
  POOL_MAX_INSTANCES: integer(20, 1, 100),
  POOL_CONCURRENCY: integer(1, 1, 16),
  POOL_IDLE_MS: integer(600_000, 1_000, 86_400_000),
  POOL_MAX_QUEUED: integer(100, 1, 10_000),
});
const decodeVariables = Schema.decodeUnknownSync(Variables);

export type PoolSettings = {
  /** Containers kept running at rest. Zero means strict scale-to-zero. */
  minWarm: number;
  /** Matches `max_instances` in wrangler.jsonc. */
  maxInstances: number;
  /** Compiles one container runs at once. */
  concurrency: number;
  /** The pool drains this long after its last lease or queued compile. */
  idleMs: number;
  /** Compiles that may wait for a container before new ones are refused. */
  maxQueued: number;
  /** How long a compile waits for a container, including a cold start. */
  claimTimeoutMs: number;
  /** How long an incremental compile waits for its own container. */
  affinityWaitMs: number;
  /**
   * Added to a compile's timeout before its lease is presumed abandoned. Longer
   * than everything else a compile may spend holding one.
   */
  leaseMarginMs: number;
  /** The period over which misses and queue pressure are measured. */
  windowMs: number;
};

export function poolSettings(variables: unknown): PoolSettings {
  const decoded = decodeVariables(variables);
  return {
    minWarm: Math.min(decoded.POOL_MIN_WARM, decoded.POOL_MAX_INSTANCES),
    maxInstances: decoded.POOL_MAX_INSTANCES,
    concurrency: decoded.POOL_CONCURRENCY,
    idleMs: decoded.POOL_IDLE_MS,
    maxQueued: decoded.POOL_MAX_QUEUED,
    claimTimeoutMs: 60_000,
    affinityWaitMs: 2_000,
    leaseMarginMs: 240_000,
    windowMs: 60_000,
  };
}

export class PoolConfig extends Context.Service<PoolConfig, PoolSettings>()(
  "compiler/PoolConfig",
) {
  static layer = (variables: unknown) =>
    Layer.sync(PoolConfig, () => poolSettings(variables));
}
