import type { PoolSettings } from "./config";

// Scaling decisions as pure functions of observed demand.

export type Demand = {
  activeLeases: number;
  queuedRequests: number;
};

/** Containers needed to run and queue this much work, with nothing spare. */
export const containersFor = (
  { activeLeases, queuedRequests }: Demand,
  { concurrency }: Pick<PoolSettings, "concurrency">,
) => Math.ceil((activeLeases + queuedRequests) / concurrency);

/** How many containers should be running or starting now. */
export function desiredSize(
  demand: Demand & { spare: number },
  settings: Pick<PoolSettings, "concurrency" | "minWarm" | "maxInstances">,
) {
  return Math.min(
    settings.maxInstances,
    Math.max(settings.minWarm, containersFor(demand, settings) + demand.spare),
  );
}

export type DemandWindow = {
  startedAt: number;
  hits: number;
  misses: number;
  /** The most compiles that waited at one time. */
  peakQueued: number;
};

/**
 * Spare capacity grows while claims keep missing warm containers or queue up,
 * and shrinks by one in each window without that pressure.
 */
export function nextSpare(
  spare: number,
  window: DemandWindow,
  { maxInstances }: Pick<PoolSettings, "maxInstances">,
) {
  const claims = window.hits + window.misses;
  const missing = window.misses >= 2 && window.misses / claims >= 0.25;
  return missing || window.peakQueued >= 2
    ? Math.min(maxInstances, Math.max(1, spare * 2))
    : Math.max(0, spare - 1);
}

export type DemandSample = { at: number; containers: number };
const sampleMs = 60_000;

/** Records the most containers needed in each minute of the idle window. */
export function recordDemand(
  samples: readonly DemandSample[],
  containers: number,
  now: number,
  { idleMs }: Pick<PoolSettings, "idleMs">,
): DemandSample[] {
  const kept = samples.filter((sample) => now - sample.at < idleMs);
  if (containers === 0) return kept;
  const last = kept.at(-1);
  if (last && Math.floor(last.at / sampleMs) === Math.floor(now / sampleMs))
    return [
      ...kept.slice(0, -1),
      { at: now, containers: Math.max(last.containers, containers) },
    ];
  return [...kept, { at: now, containers }];
}

/**
 * How many containers to keep. Surplus capacity drains only after the whole
 * idle window has passed without needing it.
 */
export function retainedSize(
  desired: number,
  samples: readonly DemandSample[],
  { maxInstances }: Pick<PoolSettings, "maxInstances">,
) {
  return Math.min(
    maxInstances,
    samples.reduce(
      (peak, sample) => Math.max(peak, sample.containers),
      desired,
    ),
  );
}
