import {
  Clock,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schedule,
  Schema,
  Scope,
} from "effect";

import {
  containersFor,
  desiredSize,
  nextSpare,
  recordDemand,
  retainedSize,
} from "./autoscaler";
import { Background } from "./background";
import { PoolConfig } from "./config";
import { Containers } from "./containers";
import {
  CompileCancelled,
  type ClaimError,
  PoolSaturated,
  PoolUnavailable,
  ResyncRequired,
} from "./errors";

export const ClaimRequest = Schema.Struct({
  id: Schema.String,
  affinity: Schema.String,
  timeoutMs: Schema.Finite,
  priority: Schema.Finite,
  /** Only this container will do; it must still hold the affinity. */
  container: Schema.optionalKey(Schema.String),
});
export type ClaimRequest = typeof ClaimRequest.Type;

export const Lease = Schema.Struct({
  id: Schema.String,
  container: Schema.String,
  slot: Schema.Int,
  generation: Schema.Int,
  outcome: Schema.Literals(["affinity", "spare", "cold"]),
  waitMs: Schema.Finite,
});
export type Lease = typeof Lease.Type;

const SlotState = Schema.Struct({
  generation: Schema.Int,
  affinity: Schema.NullOr(Schema.String),
  lastUsed: Schema.Finite,
  lease: Schema.NullOr(
    Schema.Struct({ id: Schema.String, expiresAt: Schema.Finite }),
  ),
});
const PoolState = Schema.Struct({
  version: Schema.Literal(1),
  containers: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      // A draining container is stopped once the compiles it still runs end.
      status: Schema.Literals(["starting", "ready", "draining", "stopping"]),
      slots: Schema.Array(SlotState),
    }),
  ),
  spare: Schema.Int,
  window: Schema.Struct({
    startedAt: Schema.Finite,
    hits: Schema.Int,
    misses: Schema.Int,
    peakQueued: Schema.Int,
  }),
  demand: Schema.Array(
    Schema.Struct({ at: Schema.Finite, containers: Schema.Int }),
  ),
});
type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T;
type State = Mutable<typeof PoolState.Type>;
type ContainerState = State["containers"][number];
type Slot = ContainerState["slots"][number];
export type PoolSnapshot = typeof PoolState.Type & { queued: number };

const maxEnded = 1024;

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(PoolState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(PoolState));

/** Durable storage for one pool's state. Both calls are synchronous. */
export class PoolStore extends Context.Service<
  PoolStore,
  { load(): string | null; save(value: string): void }
>()("compiler/PoolStore") {
  static memory = Layer.sync(PoolStore, () => {
    let saved: string | null = null;
    return PoolStore.of({
      load: () => saved,
      save: (value) => {
        saved = value;
      },
    });
  });
}

type Waiter = {
  request: ClaimRequest;
  sequence: number;
  startedAt: number;
  granted: Deferred.Deferred<Lease, ClaimError>;
};

/** What compile handlers need from the pool, locally or over RPC. */
export type PoolClient = {
  claim(request: ClaimRequest): Effect.Effect<Lease, ClaimError>;
  /**
   * Ends a lease or a wait. A reusable container is offered again immediately;
   * any other container is replaced once nothing else runs in it.
   */
  release(id: string, options: { reusable: boolean }): Effect.Effect<void>;
  /**
   * Ends a wait, or a claim that has yet to arrive. A compile that already holds
   * a lease keeps it, and the caller must stop that run.
   */
  cancel(id: string): Effect.Effect<Lease | null>;
};

export class Pool extends Context.Service<Pool, PoolClient>()(
  "compiler/Pool",
) {}

/** The pool itself, which also runs its own maintenance. */
export class PoolManagerService extends Context.Service<
  PoolManagerService,
  PoolClient & {
    /** Checks idle containers, recovers abandoned work, and resizes. */
    maintain: Effect.Effect<void>;
    snapshot: Effect.Effect<PoolSnapshot>;
    /** Nothing is running, waiting, or owed cleanup. */
    idle: Effect.Effect<boolean>;
  }
>()("compiler/PoolManager") {
  static layer = Layer.effect(
    PoolManagerService,
    Effect.gen(function* () {
      const settings = yield* PoolConfig;
      const containers = yield* Containers;
      const store = yield* PoolStore;
      const keepAlive = yield* Background;
      const scope = yield* Scope.Scope;
      const now = yield* Clock.currentTimeMillis;
      const saved = store.load();
      const state: State = saved
        ? (structuredClone(decodeState(saved)) as State)
        : {
            version: 1,
            containers: [],
            spare: 0,
            window: { startedAt: now, hits: 0, misses: 0, peakQueued: 0 },
            demand: [],
          };
      const waiters: Waiter[] = [];
      let sequence = 0;
      // IDs ended before their claim arrived, such as by an early cancellation.
      const ended = new Set<string>();
      const endEarly = (id: string) => {
        ended.delete(id);
        ended.add(id);
        // The oldest has had the longest to meet its claim.
        const [oldest] = ended;
        if (ended.size > maxEnded && oldest !== undefined) ended.delete(oldest);
      };

      // Every transition below is synchronous, so transitions never interleave.
      const persist = () => store.save(encodeState(state));
      const slots = () =>
        state.containers.flatMap((container) =>
          container.slots.map((slot, index) => ({ container, slot, index })),
        );
      const demand = () => ({
        // A draining container will serve nothing after its own leases.
        activeLeases: slots().filter(
          ({ container, slot }) =>
            slot.lease && container.status !== "draining",
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
            Number(a.slot.affinity !== null) -
              Number(b.slot.affinity !== null) ||
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
          Deferred.doneUnsafe(waiter.granted, Effect.succeed(lease));
        }
      };

      const remove = (name: string) => {
        state.containers = state.containers.filter(
          (container) => container.name !== name,
        );
      };

      const stopping = new Set<string>();
      const stopContainer = (name: string): Effect.Effect<void> =>
        Effect.suspend(() => {
          const owed = state.containers.some(
            (entry) => entry.name === name && entry.status === "stopping",
          );
          if (!owed || stopping.has(name)) return Effect.void;
          stopping.add(name);
          return containers.stop(name).pipe(
            Effect.timeout("60 seconds"),
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("500 millis"),
            }),
            Effect.ensuring(Effect.sync(() => stopping.delete(name))),
            Effect.matchEffect({
              // Maintenance tries again; the container still counts until then.
              onFailure: (cause) =>
                Effect.logError("Container stop failed", { name, cause }),
              onSuccess: () =>
                Effect.suspend(() => {
                  remove(name);
                  persist();
                  // The freed instance may be what a waiting compile needs.
                  return waiters.length ? resize : Effect.void;
                }),
            }),
          );
        });

      // Takes a container out of use without ending the compiles it still runs.
      const retire = (container: ContainerState) => {
        container.status = leased(container) ? "draining" : "stopping";
      };

      const startContainer = (name: string): Effect.Effect<void> =>
        containers.start(name).pipe(
          Effect.timeout("90 seconds"),
          Effect.matchEffect({
            onFailure: (cause) =>
              Effect.gen(function* () {
                yield* Effect.logError("Container start failed", {
                  name,
                  cause,
                });
                const container = state.containers.find(
                  (entry) => entry.name === name,
                );
                if (!container) return;
                retire(container);
                // With nothing left that could serve them, waiting compiles
                // fail now so their callers can retry.
                if (
                  !state.containers.some(
                    ({ status }) => status === "starting" || status === "ready",
                  )
                )
                  for (const waiter of waiters.splice(0))
                    Deferred.doneUnsafe(
                      waiter.granted,
                      Effect.fail(
                        new PoolUnavailable({
                          message: "No compile container could be started",
                        }),
                      ),
                    );
                persist();
                yield* stopContainer(name);
              }),
            onSuccess: () =>
              Effect.gen(function* () {
                const at = yield* Clock.currentTimeMillis;
                const container = state.containers.find(
                  (entry) => entry.name === name,
                );
                if (container?.status !== "starting") return;
                container.status = "ready";
                dispatch(at);
                persist();
              }),
          }),
        );

      const background = (effect: Effect.Effect<void>) =>
        Effect.forkIn(effect, scope).pipe(
          Effect.map((fiber) =>
            keepAlive.run(Effect.asVoid(Fiber.await(fiber))),
          ),
        );

      const resize: Effect.Effect<void> = Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
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
        const desired = desiredSize(
          { ...demand(), spare: state.spare },
          settings,
        );
        const running = () =>
          state.containers.filter(
            ({ status }) => status === "starting" || status === "ready",
          );
        const work: Effect.Effect<void>[] = [];
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
          work.push(startContainer(name));
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
          work.push(stopContainer(container.name));
        }
        persist();
        yield* Effect.forEach(work, background, { discard: true });
      });

      const dropWaiter = (waiter: Waiter) => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
      };

      const wait = (waiter: Waiter, limitMs: number, expired: ClaimError) =>
        Deferred.await(waiter.granted).pipe(
          Effect.timeoutOrElse({
            duration: limitMs,
            orElse: () => Effect.fail(expired),
          }),
          // A grant may race the timeout or an interruption; give it back.
          Effect.onExit((exit) =>
            exit._tag === "Success"
              ? Effect.void
              : Effect.suspend(() => {
                  dropWaiter(waiter);
                  return findLease(waiter.request.id)
                    ? release(waiter.request.id, { reusable: true })
                    : Effect.void;
                }),
          ),
        );

      const claim = Effect.fnUntraced(function* (
        request: ClaimRequest,
      ): Effect.fn.Return<Lease, ClaimError> {
        const at = yield* Clock.currentTimeMillis;
        if (ended.delete(request.id)) return yield* new CompileCancelled();
        if (
          findLease(request.id) ||
          waiters.some((entry) => entry.request.id === request.id)
        )
          return yield* new PoolUnavailable({
            message: "This compile ID is already in use",
          });
        const waiter: Waiter = {
          request,
          sequence: sequence++,
          startedAt: at,
          granted: yield* Deferred.make<Lease, ClaimError>(),
        };
        const found = pick(request);
        if (found) {
          const lease = grant(waiter, found.target, found.warm, at);
          state.window.hits++;
          recordNow(at);
          persist();
          return lease;
        }
        if (request.container !== undefined) {
          // Its previous compile may be a moment away from giving it back.
          const held = slots().some(
            ({ container, slot }) =>
              container.name === request.container &&
              container.status === "ready" &&
              slot.affinity === request.affinity,
          );
          if (!held) return yield* new ResyncRequired();
          waiters.push(waiter);
          return yield* wait(
            waiter,
            settings.affinityWaitMs,
            new ResyncRequired(),
          );
        }
        if (waiters.length >= settings.maxQueued)
          return yield* new PoolSaturated();
        waiters.push(waiter);
        state.window.misses++;
        state.window.peakQueued = Math.max(
          state.window.peakQueued,
          waiters.length,
        );
        yield* resize;
        return yield* wait(
          waiter,
          settings.claimTimeoutMs,
          new PoolUnavailable({
            message: "No compile container became available in time",
          }),
        );
      });

      const endWait = (id: string) => {
        const waiter = waiters.find((entry) => entry.request.id === id);
        if (!waiter) return endEarly(id);
        dropWaiter(waiter);
        Deferred.doneUnsafe(
          waiter.granted,
          Effect.fail(new CompileCancelled()),
        );
      };

      const release = Effect.fnUntraced(function* (
        id: string,
        { reusable }: { reusable: boolean },
      ) {
        const at = yield* Clock.currentTimeMillis;
        const found = findLease(id);
        if (!found) return endWait(id);
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
        yield* background(stopContainer(found.container.name));
        if (waiters.length) yield* resize;
      });

      // One synchronous step, so a claim is cancelled or granted but never both.
      const cancel = (id: string) =>
        Effect.sync((): Lease | null => {
          const found = findLease(id);
          if (!found) {
            endWait(id);
            return null;
          }
          return {
            id,
            container: found.container.name,
            slot: found.index,
            generation: found.slot.generation,
            outcome: "affinity",
            waitMs: 0,
          };
        });

      const probe = (container: ContainerState) =>
        containers.probe(container.name).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Idle container failed its check", {
                name: container.name,
                cause,
              });
              // A compile may have claimed it meanwhile; that compile decides.
              if (container.status !== "ready" || leased(container)) return;
              retire(container);
              persist();
              yield* stopContainer(container.name);
            }),
          ),
        );

      const maintain = Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        for (const container of state.containers) {
          const abandoned = container.slots.filter(
            (slot) => slot.lease && slot.lease.expiresAt <= at,
          );
          if (abandoned.length === 0) continue;
          for (const slot of abandoned) slot.lease = null;
          retire(container);
          yield* Effect.logWarning("Compile lease expired", {
            name: container.name,
          });
        }
        yield* resize;
        yield* Effect.forEach(
          state.containers.filter(({ status }) => status === "stopping"),
          ({ name }) => stopContainer(name),
          { concurrency: 5, discard: true },
        );
        // Idle containers stay claimable while they are checked. The request
        // also keeps the platform from putting retained capacity to sleep.
        yield* Effect.forEach(
          state.containers.filter(
            (container) => container.status === "ready" && !leased(container),
          ),
          probe,
          { concurrency: 5, discard: true },
        );
      });

      // Finish what a previous instance of this pool had begun.
      for (const { name, status } of state.containers) {
        if (status === "starting") yield* background(startContainer(name));
        else if (status === "stopping") yield* background(stopContainer(name));
      }

      return PoolManagerService.of({
        claim,
        release,
        cancel,
        maintain,
        snapshot: Effect.sync(() => ({
          ...structuredClone(state),
          queued: waiters.length,
        })),
        idle: Effect.sync(
          () => state.containers.length === 0 && waiters.length === 0,
        ),
      });
    }),
  );

  /** The same pool, offered to compile handlers in this process. */
  static poolLayer = Layer.effect(
    Pool,
    Effect.map(PoolManagerService, (manager) =>
      Pool.of({
        claim: manager.claim,
        release: manager.release,
        cancel: manager.cancel,
      }),
    ),
  );
}
