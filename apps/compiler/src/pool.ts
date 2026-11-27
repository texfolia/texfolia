import { z } from "zod";

import {
  containersFor,
  desiredSize,
  nextSpare,
  recordDemand,
  retainedSize,
} from "./autoscaler";
import type { PoolSettings } from "./config";
import type { ContainerPlatform } from "./containers";
import type { ClaimError } from "./errors";

export const claimRequestSchema = z.object({
  id: z.string(),
  affinity: z.string(),
  timeoutMs: z.number().finite(),
  priority: z.number().finite(),
  /** Only this container will do; it must still hold the affinity. */
  container: z.string().optional(),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

export const leaseSchema = z.object({
  id: z.string(),
  container: z.string(),
  slot: z.number().int(),
  generation: z.number().int(),
  outcome: z.enum(["affinity", "spare", "cold"]),
  waitMs: z.number().finite(),
});
export type Lease = z.infer<typeof leaseSchema>;

export const claimResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), lease: leaseSchema }),
  z.object({ ok: z.literal(false), code: z.literal("resync") }),
  z.object({ ok: z.literal(false), code: z.literal("cancelled") }),
  z.object({ ok: z.literal(false), code: z.literal("saturated") }),
  z.object({
    ok: z.literal(false),
    code: z.literal("unavailable"),
    message: z.string(),
  }),
]);
export type ClaimResult = z.infer<typeof claimResultSchema>;

const slotStateSchema = z.object({
  generation: z.number().int(),
  affinity: z.string().nullable(),
  lastUsed: z.number().finite(),
  lease: z
    .object({ id: z.string(), expiresAt: z.number().finite() })
    .nullable(),
});

const poolStateSchema = z.object({
  version: z.literal(1),
  containers: z.array(
    z.object({
      name: z.string(),
      // A draining container is stopped once the compiles it still runs end.
      status: z.enum(["starting", "ready", "draining", "stopping"]),
      slots: z.array(slotStateSchema),
    }),
  ),
  spare: z.number().int(),
  window: z.object({
    startedAt: z.number().finite(),
    hits: z.number().int(),
    misses: z.number().int(),
    peakQueued: z.number().int(),
  }),
  demand: z.array(
    z.object({ at: z.number().finite(), containers: z.number().int() }),
  ),
});

type State = z.infer<typeof poolStateSchema>;
type ContainerState = State["containers"][number];
type Slot = ContainerState["slots"][number];
export type PoolSnapshot = State & { queued: number };

const maxEnded = 1024;
const startTimeoutMs = 90_000;
const stopTimeoutMs = 60_000;
const stopRetryDelaysMs = [500, 1000] as const;

/** Durable storage for one pool's state. Both calls are synchronous. */
export interface PoolStore {
  load(): string | null;
  save(value: string): void;
}

export function memoryPoolStore(): PoolStore {
  let saved: string | null = null;
  return {
    load: () => saved,
    save: (value) => {
      saved = value;
    },
  };
}

/** Injectable clock for deterministic scheduling tests. */
export interface PoolClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: PoolClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What compile handlers need from the pool, locally or over RPC. */
export interface PoolClient {
  claim(request: ClaimRequest, signal?: AbortSignal): Promise<ClaimResult>;
  /**
   * Ends a lease or a wait. A reusable container is offered again immediately;
   * any other container is replaced once nothing else runs in it.
   */
  release(id: string, options: { reusable: boolean }): Promise<void>;
  /**
   * Ends a wait, or a claim that has yet to arrive. A compile that already holds
   * a lease keeps it, and the caller must stop that run.
   */
  cancel(id: string): Promise<Lease | null>;
}

export interface PoolManagerCore extends PoolClient {
  /** Recovers abandoned leases, resizes, and retries failed stops. */
  maintain(): Promise<void>;
  snapshot(): PoolSnapshot;
  /** Nothing is running, waiting, or owed cleanup. */
  idle(): boolean;
  /** Cancels timers when shutting down a local instance. */
  dispose(): void;
}

type Waiter = {
  request: ClaimRequest;
  sequence: number;
  startedAt: number;
  resolve: (result: ClaimResult) => void;
};

async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  const queue = items.slice();
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        await run(next);
      }
    },
  );
  await Promise.all(workers);
}

export function createPoolManager({
  settings,
  containers,
  store,
  waitUntil = () => {},
  clock = systemClock,
}: {
  settings: PoolSettings;
  containers: ContainerPlatform;
  store: PoolStore;
  waitUntil?: (task: Promise<unknown>) => void;
  clock?: PoolClock;
}): PoolManagerCore {
  const saved = store.load();
  const state: State = saved
    ? structuredClone(poolStateSchema.parse(JSON.parse(saved)))
    : {
        version: 1,
        containers: [],
        spare: 0,
        window: { startedAt: clock.now(), hits: 0, misses: 0, peakQueued: 0 },
        demand: [],
      };
  const waiters: Waiter[] = [];
  let sequence = 0;
  let disposed = false;
  const timers = new Set<unknown>();
  // IDs ended before their claim arrived, such as by an early cancellation.
  const ended = new Set<string>();
  const stopping = new Set<string>();

  const scheduleTimer = (callback: () => void, ms: number) => {
    const handle = clock.setTimeout(() => {
      timers.delete(handle);
      callback();
    }, ms);
    timers.add(handle);
    return handle;
  };
  const cancelTimer = (handle: unknown) => {
    if (timers.delete(handle)) clock.clearTimeout(handle);
  };

  const withTimeout = <A>(
    ms: number,
    run: (signal: AbortSignal) => Promise<A>,
  ) =>
    new Promise<A>((resolve, reject) => {
      const controller = new AbortController();
      const timer = scheduleTimer(() => {
        const error = new Error(`Operation timed out after ${ms}ms`);
        controller.abort(error);
        reject(error);
      }, ms);
      run(controller.signal).then(
        (value) => {
          cancelTimer(timer);
          resolve(value);
        },
        (error: unknown) => {
          cancelTimer(timer);
          reject(error);
        },
      );
    });

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      scheduleTimer(resolve, ms);
    });

  const endEarly = (id: string) => {
    ended.delete(id);
    ended.add(id);
    // The oldest has had the longest to meet its claim.
    const [oldest] = ended;
    if (ended.size > maxEnded && oldest !== undefined) ended.delete(oldest);
  };

  // Every transition below is synchronous, so transitions never interleave.
  const persist = () => store.save(JSON.stringify(state));
  const slots = () =>
    state.containers.flatMap((container) =>
      container.slots.map((slot, index) => ({ container, slot, index })),
    );
  const demand = () => ({
    // A draining container will serve nothing after its own leases.
    activeLeases: slots().filter(
      ({ container, slot }) => slot.lease && container.status !== "draining",
    ).length,
    // A compile waiting for its own container cannot use a new one.
    queuedRequests: waiters.filter(
      ({ request }) => request.container === undefined,
    ).length,
  });
  const recordNow = (at: number) => {
    state.demand = recordDemand(
      state.demand,
      Math.min(settings.maxInstances, containersFor(demand(), settings)),
      at,
      settings,
    );
  };
  const findLease = (id: string) =>
    slots().find(({ slot }) => slot.lease?.id === id);
  const leased = (container: ContainerState) =>
    container.slots.some((slot) => slot.lease);

  const grant = (
    waiter: Pick<Waiter, "request" | "startedAt">,
    target: { container: ContainerState; slot: Slot; index: number },
    outcome: Lease["outcome"],
    at: number,
  ): Lease => {
    const { container, slot, index } = target;
    slot.generation++;
    slot.affinity = waiter.request.affinity;
    slot.lastUsed = at;
    slot.lease = {
      id: waiter.request.id,
      expiresAt: at + waiter.request.timeoutMs + settings.leaseMarginMs,
    };
    return {
      id: waiter.request.id,
      container: container.name,
      slot: index,
      generation: slot.generation,
      outcome,
      waitMs: at - waiter.startedAt,
    };
  };

  // A container that already holds the caller's sources is best. Otherwise
  // take an unassigned one, then the one whose caller has been away longest.
  const pick = (request: ClaimRequest) => {
    const free = slots().filter(
      ({ container, slot }) => container.status === "ready" && !slot.lease,
    );
    const own = free
      .filter(({ slot }) => slot.affinity === request.affinity)
      .sort((a, b) => b.slot.lastUsed - a.slot.lastUsed);
    if (request.container !== undefined) {
      const exact = own.find(
        ({ container }) => container.name === request.container,
      );
      return exact && { target: exact, warm: "affinity" as const };
    }
    if (own[0]) return { target: own[0], warm: "affinity" as const };
    const other = free.sort(
      (a, b) =>
        Number(a.slot.affinity !== null) - Number(b.slot.affinity !== null) ||
        a.slot.lastUsed - b.slot.lastUsed,
    )[0];
    return other && { target: other, warm: "spare" as const };
  };

  const dispatch = (at: number) => {
    waiters.sort(
      (a, b) =>
        b.request.priority - a.request.priority || a.sequence - b.sequence,
    );
    for (const waiter of waiters.slice()) {
      const found = pick(waiter.request);
      if (!found) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      const lease = grant(
        waiter,
        found.target,
        waiter.request.container === undefined ? "cold" : "affinity",
        at,
      );
      waiter.resolve({ ok: true, lease });
    }
  };

  const remove = (name: string) => {
    state.containers = state.containers.filter(
      (container) => container.name !== name,
    );
  };

  // Takes a container out of use without ending the compiles it still runs.
  const retire = (container: ContainerState) => {
    container.status = leased(container) ? "draining" : "stopping";
  };

  const runBackground = (task: Promise<void>) => {
    const tracked = task.catch((error: unknown) => {
      console.error("Compiler pool background task failed", error);
    });
    waitUntil(tracked);
  };

  const stopContainer = async (name: string): Promise<void> => {
    const owed = state.containers.some(
      (entry) => entry.name === name && entry.status === "stopping",
    );
    if (!owed || stopping.has(name) || disposed) return;
    stopping.add(name);
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt <= stopRetryDelaysMs.length; attempt++) {
        if (disposed) return;
        try {
          await withTimeout(stopTimeoutMs, (signal) =>
            containers.stop(name, signal),
          );
          if (disposed) return;
          remove(name);
          persist();
          // The freed instance may be what a waiting compile needs.
          if (waiters.length) resize();
          return;
        } catch (error) {
          lastError = error;
          const delay = stopRetryDelaysMs[attempt];
          if (delay !== undefined) await sleep(delay);
        }
      }
      // Maintenance tries again; the container still counts until then.
      console.error("Container stop failed", { name, cause: lastError });
    } finally {
      stopping.delete(name);
    }
  };

  const startContainer = async (name: string): Promise<void> => {
    try {
      await withTimeout(startTimeoutMs, (signal) =>
        containers.start(name, signal),
      );
      if (disposed) return;
      const at = clock.now();
      const container = state.containers.find((entry) => entry.name === name);
      if (container?.status !== "starting") return;
      container.status = "ready";
      dispatch(at);
      persist();
    } catch (cause) {
      if (disposed) return;
      console.error("Container start failed", { name, cause });
      const container = state.containers.find((entry) => entry.name === name);
      if (!container) return;
      retire(container);
      // With nothing left that could serve them, waiting compiles fail now so
      // their callers can retry.
      if (
        !state.containers.some(
          ({ status }) => status === "starting" || status === "ready",
        )
      )
        for (const waiter of waiters.splice(0))
          waiter.resolve({
            ok: false,
            code: "unavailable",
            message: "No compile container could be started",
          });
      persist();
      await stopContainer(name);
    }
  };

  const resize = () => {
    const at = clock.now();
    recordNow(at);
    if (at - state.window.startedAt >= settings.windowMs) {
      state.spare = nextSpare(state.spare, state.window, settings);
      state.window = {
        startedAt: at,
        hits: 0,
        misses: 0,
        peakQueued: waiters.length,
      };
    }
    // No demand in the whole idle window: drain to the warm floor.
    if (state.demand.length === 0) state.spare = 0;
    const desired = desiredSize({ ...demand(), spare: state.spare }, settings);
    const running = () =>
      state.containers.filter(
        ({ status }) => status === "starting" || status === "ready",
      );
    const starts: string[] = [];
    const stops: string[] = [];
    while (
      running().length < desired &&
      state.containers.length < settings.maxInstances
    ) {
      const name = `compiler-${crypto.randomUUID()}`;
      state.containers.push({
        name,
        status: "starting",
        slots: Array.from({ length: settings.concurrency }, () => ({
          generation: 0,
          affinity: null,
          lastUsed: at,
          lease: null,
        })),
      });
      starts.push(name);
    }
    const lastUsed = (container: ContainerState) =>
      Math.max(...container.slots.map((slot) => slot.lastUsed));
    const surplus = Math.max(
      0,
      running().length - retainedSize(desired, state.demand, settings),
    );
    for (const container of running()
      .filter((entry) => entry.status === "ready" && !leased(entry))
      .sort((a, b) => lastUsed(a) - lastUsed(b))
      .slice(0, surplus)) {
      retire(container);
      stops.push(container.name);
    }
    persist();
    for (const name of starts) runBackground(startContainer(name));
    for (const name of stops) runBackground(stopContainer(name));
  };

  const dropWaiter = (waiter: Waiter) => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
  };

  const endWait = (id: string) => {
    const waiter = waiters.find((entry) => entry.request.id === id);
    if (!waiter) return endEarly(id);
    dropWaiter(waiter);
    waiter.resolve({ ok: false, code: "cancelled" });
  };

  const releaseSync = (id: string, { reusable }: { reusable: boolean }) => {
    const at = clock.now();
    const found = findLease(id);
    if (!found) {
      endWait(id);
      return;
    }
    recordNow(at);
    found.slot.lease = null;
    found.slot.lastUsed = at;
    if (reusable && found.container.status === "ready") {
      dispatch(at);
      persist();
      return;
    }
    retire(found.container);
    persist();
    runBackground(stopContainer(found.container.name));
    if (waiters.length) resize();
  };

  const waitForLease = (
    request: ClaimRequest,
    startedAt: number,
    limitMs: number,
    expired: ClaimError,
    signal?: AbortSignal,
  ): Promise<ClaimResult> =>
    new Promise<ClaimResult>((resolve) => {
      let settled = false;
      const finish = (result: ClaimResult) => {
        if (settled) return;
        settled = true;
        cancelTimer(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const waiter: Waiter = {
        request,
        sequence: sequence++,
        startedAt,
        resolve: finish,
      };
      const onAbort = () => {
        dropWaiter(waiter);
        if (findLease(request.id)) releaseSync(request.id, { reusable: true });
        finish({ ok: false, code: "cancelled" });
      };
      const timer = scheduleTimer(() => {
        dropWaiter(waiter);
        if (findLease(request.id)) releaseSync(request.id, { reusable: true });
        finish({ ok: false, ...expired });
      }, limitMs);
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
    });

  const claim = async (
    request: ClaimRequest,
    signal?: AbortSignal,
  ): Promise<ClaimResult> => {
    const at = clock.now();
    if (ended.delete(request.id)) return { ok: false, code: "cancelled" };
    if (
      findLease(request.id) ||
      waiters.some((entry) => entry.request.id === request.id)
    )
      return {
        ok: false,
        code: "unavailable",
        message: "This compile ID is already in use",
      };
    const found = pick(request);
    if (found) {
      const lease = grant(
        { request, startedAt: at },
        found.target,
        found.warm,
        at,
      );
      state.window.hits++;
      recordNow(at);
      persist();
      return { ok: true, lease };
    }
    if (request.container !== undefined) {
      // Its previous compile may be a moment away from giving it back.
      const held = slots().some(
        ({ container, slot }) =>
          container.name === request.container &&
          container.status === "ready" &&
          slot.affinity === request.affinity,
      );
      if (!held) return { ok: false, code: "resync" };
      return waitForLease(
        request,
        at,
        settings.affinityWaitMs,
        { code: "resync" },
        signal,
      );
    }
    if (waiters.length >= settings.maxQueued)
      return { ok: false, code: "saturated" };
    state.window.misses++;
    state.window.peakQueued = Math.max(
      state.window.peakQueued,
      waiters.length + 1,
    );
    const waiting = waitForLease(
      request,
      at,
      settings.claimTimeoutMs,
      {
        code: "unavailable",
        message: "No compile container became available in time",
      },
      signal,
    );
    resize();
    return waiting;
  };

  // One synchronous step, so a claim is cancelled or granted but never both.
  const cancel = (id: string): Promise<Lease | null> => {
    const found = findLease(id);
    if (!found) {
      endWait(id);
      return Promise.resolve(null);
    }
    return Promise.resolve({
      id,
      container: found.container.name,
      slot: found.index,
      generation: found.slot.generation,
      outcome: "affinity",
      waitMs: 0,
    });
  };

  const maintain = async () => {
    const at = clock.now();
    for (const container of state.containers) {
      const abandoned = container.slots.filter(
        (slot) => slot.lease && slot.lease.expiresAt <= at,
      );
      if (abandoned.length === 0) continue;
      for (const slot of abandoned) slot.lease = null;
      retire(container);
      console.warn("Compile lease expired", { name: container.name });
    }
    resize();
    // Retry failed stops. Idle containers are not probed: Cloudflare Containers'
    // `sleepAfter` handles idle container lifecycle directly, and an unreachable
    // container is retired on the next compile attempt.
    await runWithConcurrency(
      state.containers.filter(({ status }) => status === "stopping"),
      5,
      ({ name }) => stopContainer(name),
    );
  };

  // Finish what a previous instance of this pool had begun.
  for (const { name, status } of state.containers) {
    if (status === "starting") runBackground(startContainer(name));
    else if (status === "stopping") runBackground(stopContainer(name));
  }

  return {
    claim,
    release: (id, options) => {
      releaseSync(id, options);
      return Promise.resolve();
    },
    cancel,
    maintain,
    snapshot: () => ({
      ...structuredClone(state),
      queued: waiters.length,
    }),
    idle: () => state.containers.length === 0 && waiters.length === 0,
    dispose: () => {
      disposed = true;
      for (const handle of timers) clock.clearTimeout(handle);
      timers.clear();
    },
  };
}
