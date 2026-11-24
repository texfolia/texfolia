import { describe, expect, test } from "bun:test";

import { Effect, Fiber, Layer, type Scope } from "effect";
import { TestClock } from "effect/testing";

import { Background } from "../src/background";
import { PoolConfig, poolSettings, type PoolSettings } from "../src/config";
import { Containers } from "../src/containers";
import { ContainerError } from "../src/errors";
import { type ClaimRequest, PoolManagerService, PoolStore } from "../src/pool";

type Platform = {
  started: string[];
  stopped: string[];
  probed: string[];
  startDelayMs: number;
  failStart: boolean;
  failStop: boolean;
  failProbe: Set<string>;
  probeDelayMs: number;
};

const failure = (operation: string, container: string) =>
  new ContainerError({ operation, container, cause: new Error("fixture") });

function harness(overrides: Partial<PoolSettings> = {}) {
  const platform: Platform = {
    started: [],
    stopped: [],
    probed: [],
    startDelayMs: 1000,
    failStart: false,
    failStop: false,
    failProbe: new Set(),
    probeDelayMs: 0,
  };
  let saved: string | null = null;
  const kept: Effect.Effect<void>[] = [];
  const containers = Containers.of({
    start: (name) =>
      Effect.gen(function* () {
        platform.started.push(name);
        yield* Effect.sleep(platform.startDelayMs);
        if (platform.failStart) return yield* failure("start", name);
      }),
    probe: (name) =>
      Effect.gen(function* () {
        platform.probed.push(name);
        yield* Effect.sleep(platform.probeDelayMs);
        if (platform.failProbe.has(name)) return yield* failure("probe", name);
      }),
    stop: (name) =>
      Effect.suspend(() => {
        if (platform.failStop) return Effect.fail(failure("stop", name));
        platform.stopped.push(name);
        return Effect.void;
      }),
    fetch: () => Effect.die("The pool never compiles"),
  });
  const layer = PoolManagerService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PoolConfig, { ...poolSettings({}), ...overrides }),
        Layer.succeed(Containers, containers),
        Layer.succeed(Background, {
          run: (effect) => {
            kept.push(effect);
          },
        }),
        Layer.succeed(PoolStore, {
          load: () => saved,
          save: (value) => {
            saved = value;
          },
        }),
      ),
    ),
  );
  return { platform, layer, kept, saved: () => saved };
}

const run = <A, E>(
  test: ReturnType<typeof harness>,
  program: Effect.Effect<A, E, PoolManagerService | Scope.Scope>,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(test.layer),
      Effect.provide(TestClock.layer()),
      Effect.scoped,
    ) as Effect.Effect<A, E>,
  );

const request = (
  affinity: string,
  options: Partial<ClaimRequest> = {},
): ClaimRequest => ({
  id: crypto.randomUUID(),
  affinity,
  timeoutMs: 15_000,
  priority: 0,
  ...options,
});

// Lets forked work run up to its next suspension.
const settle = TestClock.adjust(0);
const minute = TestClock.adjust("1 minute");

const claimCold = (input: ClaimRequest) =>
  Effect.gen(function* () {
    const pool = yield* PoolManagerService;
    const fiber = yield* Effect.forkChild(pool.claim(input));
    yield* TestClock.adjust("1 second");
    return yield* Fiber.join(fiber);
  });

describe("scale from and to zero", () => {
  test("an idle pool runs nothing, and maintenance starts nothing", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        yield* pool.maintain;
        yield* TestClock.adjust("1 hour");
        yield* pool.maintain;
        expect(yield* pool.idle).toBe(true);
      }),
    );
    expect(test.platform.started).toEqual([]);
  });

  test("the first claim starts one container; the next claim reuses it at once", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const first = yield* claimCold(request("a"));
        expect(first).toMatchObject({
          outcome: "cold",
          waitMs: 1000,
          generation: 1,
        });
        yield* pool.release(first.id, { reusable: true });
        const second = yield* pool.claim(request("a"));
        expect(second).toMatchObject({
          container: first.container,
          outcome: "affinity",
          waitMs: 0,
          generation: 2,
        });
        yield* pool.release(second.id, { reusable: true });
        const third = yield* pool.claim(request("b"));
        expect(third).toMatchObject({
          container: first.container,
          outcome: "spare",
          generation: 3,
        });
      }),
    );
    expect(test.platform.started).toHaveLength(1);
  });

  test("the pool drains exactly one idle window after its last lease", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const lease = yield* claimCold(request("a"));
        yield* TestClock.adjust("2 minutes");
        yield* pool.release(lease.id, { reusable: true });
        for (let index = 0; index < 9; index++) {
          yield* minute;
          yield* pool.maintain;
          expect(test.platform.stopped).toEqual([]);
        }
        yield* minute;
        yield* pool.maintain;
        yield* settle;
        expect(test.platform.stopped).toEqual([lease.container]);
        expect(yield* pool.idle).toBe(true);
      }),
    );
  });

  test("a warm floor survives the drain", async () => {
    const test = harness({ minWarm: 2 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        yield* pool.maintain;
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("1 hour");
        yield* pool.maintain;
        expect((yield* pool.snapshot).containers.map((c) => c.status)).toEqual([
          "ready",
          "ready",
        ]);
      }),
    );
    expect(test.platform.stopped).toEqual([]);
  });
});

describe("scale up", () => {
  test("a burst starts one container per waiting compile, up to the maximum, and queues the rest", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const fibers = yield* Effect.forEach(
          Array.from({ length: 25 }, (_, index) => request(`p${index}`)),
          (input) => Effect.forkChild(pool.claim(input)),
        );
        yield* settle;
        expect(test.platform.started).toHaveLength(20);
        yield* TestClock.adjust("1 second");
        const snapshot = yield* pool.snapshot;
        expect(snapshot.queued).toBe(5);
        const first = yield* Fiber.join(fibers[0]!);
        yield* pool.release(first.id, { reusable: true });
        const queued = yield* Fiber.join(fibers[20]!);
        expect(queued.container).toBe(first.container);
        expect((yield* pool.snapshot).queued).toBe(4);
      }),
    );
    expect(test.platform.started).toHaveLength(20);
  });

  test("a released container serves a waiting compile before its own cold start finishes", async () => {
    const test = harness();
    test.platform.startDelayMs = 30_000;
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const first = yield* Effect.forkChild(pool.claim(request("a")));
        yield* TestClock.adjust("30 seconds");
        const lease = yield* Fiber.join(first);
        const second = yield* Effect.forkChild(pool.claim(request("b")));
        yield* TestClock.adjust("1 second");
        yield* pool.release(lease.id, { reusable: true });
        expect(yield* Fiber.join(second)).toMatchObject({
          container: lease.container,
          waitMs: 1000,
        });
      }),
    );
  });

  test("repeated misses add spare capacity beyond the current demand", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const held = [
          yield* claimCold(request("a")),
          yield* claimCold(request("b")),
          yield* claimCold(request("c")),
        ];
        yield* minute;
        yield* pool.maintain;
        yield* TestClock.adjust("1 second");
        expect((yield* pool.snapshot).spare).toBe(1);
        expect(test.platform.started).toHaveLength(4);
        expect(yield* pool.claim(request("d"))).toMatchObject({
          outcome: "spare",
        });
        // Quiet windows give the spare back.
        for (const lease of held)
          yield* pool.release(lease.id, { reusable: true });
        yield* minute;
        yield* pool.maintain;
        expect((yield* pool.snapshot).spare).toBe(0);
      }),
    );
  });

  test("concurrency above one fills a container before starting another", async () => {
    const test = harness({ concurrency: 2 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const first = yield* claimCold(request("a"));
        const second = yield* pool.claim(request("b"));
        expect(second.container).toBe(first.container);
        expect([first.slot, second.slot]).toEqual([0, 1]);
        yield* Effect.forkChild(pool.claim(request("c")));
        yield* settle;
        expect(test.platform.started).toHaveLength(2);
      }),
    );
  });
});

describe("claims", () => {
  test("a caller returns to its own container, and a stranger takes the one idle longest", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const a = yield* claimCold(request("a"));
        const b = yield* claimCold(request("b"));
        yield* pool.release(a.id, { reusable: true });
        yield* TestClock.adjust("1 second");
        yield* pool.release(b.id, { reusable: true });
        const again = yield* pool.claim(request("b"));
        expect(again).toMatchObject({
          container: b.container,
          outcome: "affinity",
        });
        yield* pool.release(again.id, { reusable: true });
        expect(yield* pool.claim(request("c"))).toMatchObject({
          container: a.container,
          outcome: "spare",
        });
      }),
    );
  });

  test("an incremental claim gets its exact container or a resync, never another one", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const a = yield* claimCold(request("a"));
        yield* pool.release(a.id, { reusable: true });
        const own = yield* pool.claim(request("a", { container: a.container }));
        expect(own).toMatchObject({
          container: a.container,
          outcome: "affinity",
        });
        // It waits briefly while its previous compile gives the container back.
        const waiting = yield* Effect.forkChild(
          pool.claim(request("a", { container: a.container })),
        );
        yield* TestClock.adjust("100 millis");
        yield* pool.release(own.id, { reusable: true });
        const next = yield* Fiber.join(waiting);
        expect(next).toMatchObject({ container: a.container, waitMs: 100 });
        const late = yield* Effect.forkChild(
          Effect.flip(pool.claim(request("a", { container: a.container }))),
        );
        yield* TestClock.adjust("2 seconds");
        expect((yield* Fiber.join(late))._tag).toBe("ResyncRequired");
        yield* pool.release(next.id, { reusable: true });
        const stranger = yield* pool.claim(request("b"));
        yield* pool.release(stranger.id, { reusable: true });
        for (const container of [a.container, "compiler-gone"])
          expect(
            (yield* Effect.flip(pool.claim(request("a", { container }))))._tag,
          ).toBe("ResyncRequired");
      }),
    );
    expect(test.platform.started).toHaveLength(1);
  });

  test("higher priority waits less; equal priority is first come, first served", async () => {
    const test = harness({ maxInstances: 1 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        let held = yield* claimCold(request("holder"));
        const order: string[] = [];
        const started = yield* Effect.forEach(
          [
            request("low-1"),
            request("low-2"),
            request("high-1", { priority: 1 }),
            request("high-2", { priority: 1 }),
          ],
          (input) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.forkChild(
                pool.claim(input).pipe(
                  Effect.tap((lease) =>
                    Effect.sync(() => {
                      order.push(input.affinity);
                      held = lease;
                    }),
                  ),
                ),
              );
              yield* settle;
              return fiber;
            }),
        );
        for (let index = 0; index < 4; index++) {
          yield* pool.release(held.id, { reusable: true });
          yield* settle;
        }
        yield* Effect.forEach(started, Fiber.join);
        expect(order).toEqual(["high-1", "high-2", "low-1", "low-2"]);
      }),
    );
  });

  test("a full queue refuses work and a stuck claim times out without leaking a place", async () => {
    const test = harness({ maxInstances: 1, maxQueued: 1 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const held = yield* claimCold(request("a"));
        const waiting = yield* Effect.forkChild(
          Effect.flip(pool.claim(request("b"))),
        );
        yield* settle;
        expect((yield* Effect.flip(pool.claim(request("c"))))._tag).toBe(
          "PoolSaturated",
        );
        yield* TestClock.adjust("60 seconds");
        expect((yield* Fiber.join(waiting))._tag).toBe("PoolUnavailable");
        expect((yield* pool.snapshot).queued).toBe(0);
        yield* pool.release(held.id, { reusable: true });
        expect(
          (yield* pool.snapshot).containers[0]?.slots[0]?.lease,
        ).toBeNull();
      }),
    );
  });

  test("an interrupted or cancelled wait gives up its place", async () => {
    const test = harness({ maxInstances: 1 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const held = yield* claimCold(request("a"));
        const interrupted = yield* Effect.forkChild(pool.claim(request("b")));
        const input = request("c");
        const cancelled = yield* Effect.forkChild(
          Effect.flip(pool.claim(input)),
        );
        yield* settle;
        expect((yield* pool.snapshot).queued).toBe(2);
        yield* Fiber.interrupt(interrupted);
        expect(yield* pool.cancel(input.id)).toBeNull();
        expect((yield* Fiber.join(cancelled))._tag).toBe("CompileCancelled");
        expect((yield* pool.snapshot).queued).toBe(0);
        yield* pool.release(held.id, { reusable: true });
        expect(yield* pool.claim(request("d"))).toMatchObject({
          container: held.container,
        });
      }),
    );
  });

  test("a cancel that overtakes its claim still wins", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const input = request("a");
        expect(yield* pool.cancel(input.id)).toBeNull();
        expect((yield* Effect.flip(pool.claim(input)))._tag).toBe(
          "CompileCancelled",
        );
        expect(yield* claimCold(request("a"))).toMatchObject({
          outcome: "cold",
        });
      }),
    );
    expect(test.platform.started).toHaveLength(1);
  });

  test("a compile ID cannot hold two leases", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const input = request("a");
        yield* claimCold(input);
        expect((yield* Effect.flip(pool.claim(input)))._tag).toBe(
          "PoolUnavailable",
        );
      }),
    );
  });

  test("a cancel leaves a lease to its compile and names the container to stop", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const held = yield* claimCold(request("a"));
        expect(yield* pool.cancel(held.id)).toMatchObject({
          container: held.container,
          slot: held.slot,
          generation: 1,
        });
        const [container] = (yield* pool.snapshot).containers;
        expect(container?.slots[0]?.lease?.id).toBe(held.id);
      }),
    );
  });

  test("a cancel that meets a grant either prevents it or reports it", async () => {
    const test = harness({ maxInstances: 1 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const held = yield* claimCold(request("a"));
        const input = request("b");
        const waiting = yield* Effect.forkChild(pool.claim(input));
        yield* settle;
        // Granted, but its claim has not yet been told.
        yield* pool.release(held.id, { reusable: true });
        expect(yield* pool.cancel(input.id)).toMatchObject({
          container: held.container,
        });
        expect(yield* Fiber.join(waiting)).toMatchObject({ generation: 2 });
      }),
    );
  });

  test("early cancels are forgotten oldest first", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const inputs = Array.from({ length: 1025 }, () => request("a"));
        for (const { id } of inputs) yield* pool.cancel(id);
        for (const input of [inputs[1]!, inputs[1024]!])
          expect((yield* Effect.flip(pool.claim(input)))._tag).toBe(
            "CompileCancelled",
          );
        expect(yield* claimCold(inputs[0]!)).toMatchObject({ generation: 1 });
      }),
    );
  });

  test("a wait that ends on its own does not cancel its compile ID", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const held = yield* claimCold(request("a"));
        const input = request("a", { container: held.container });
        const waiting = yield* Effect.forkChild(Effect.flip(pool.claim(input)));
        yield* TestClock.adjust("2 seconds");
        expect((yield* Fiber.join(waiting))._tag).toBe("ResyncRequired");
        yield* pool.release(held.id, { reusable: true });
        expect(yield* pool.claim(input)).toMatchObject({ generation: 2 });
      }),
    );
  });
});

describe("failures", () => {
  test("a released container is offered again before any platform call", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const lease = yield* claimCold(request("a"));
        // No clock adjustment and no scheduler turn: nothing may be awaited.
        yield* pool.release(lease.id, { reusable: true });
        yield* pool.claim(request("b"));
      }),
    );
    expect(test.platform.probed).toEqual([]);
    expect(test.platform.stopped).toEqual([]);
  });

  test("an unusable container is replaced while compiles wait", async () => {
    const test = harness({ maxInstances: 2 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const lease = yield* claimCold(request("a"));
        yield* claimCold(request("b"));
        const waiting = yield* Effect.forkChild(pool.claim(request("c")));
        yield* settle;
        yield* pool.release(lease.id, { reusable: false });
        yield* settle;
        expect(test.platform.stopped).toEqual([lease.container]);
        yield* TestClock.adjust("1 second");
        const next = yield* Fiber.join(waiting);
        expect(next.container).not.toBe(lease.container);
      }),
    );
  });

  test("claims fail fast when no container can start, and the pool recovers", async () => {
    const test = harness();
    test.platform.failStart = true;
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const claim = yield* Effect.forkChild(
          Effect.flip(pool.claim(request("a"))),
        );
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(claim))._tag).toBe("PoolUnavailable");
        yield* settle;
        expect(yield* pool.idle).toBe(true);
        test.platform.failStart = false;
        expect(yield* claimCold(request("a"))).toMatchObject({
          outcome: "cold",
        });
      }),
    );
  });

  test("a container whose stop fails still counts and is stopped later", async () => {
    const test = harness({ maxInstances: 1 });
    test.platform.failStop = true;
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const lease = yield* claimCold(request("a"));
        yield* pool.release(lease.id, { reusable: false });
        yield* TestClock.adjust("10 seconds");
        expect((yield* pool.snapshot).containers).toMatchObject([
          { name: lease.container, status: "stopping" },
        ]);
        const waiting = yield* Effect.forkChild(pool.claim(request("b")));
        yield* settle;
        expect(test.platform.started).toHaveLength(1);
        test.platform.failStop = false;
        yield* pool.maintain;
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(waiting);
        expect(test.platform.started).toHaveLength(2);
      }),
    );
  });

  test("an abandoned lease is replaced after its own deadline", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const lease = yield* claimCold(request("a", { timeoutMs: 15_000 }));
        yield* TestClock.adjust(254_000);
        yield* pool.maintain;
        expect(test.platform.stopped).toEqual([]);
        yield* TestClock.adjust(1_000);
        yield* pool.maintain;
        expect(test.platform.stopped).toEqual([lease.container]);
        // The late release of that lease changes nothing.
        yield* pool.release(lease.id, { reusable: true });
        expect((yield* pool.snapshot).containers).toEqual([]);
      }),
    );
  });

  test("idle checks never hide a container, and only an idle one is replaced", async () => {
    const test = harness();
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const a = yield* claimCold(request("a"));
        const b = yield* claimCold(request("b"));
        yield* pool.release(a.id, { reusable: true });
        test.platform.failProbe.add(a.container).add(b.container);
        const maintaining = yield* Effect.forkChild(pool.maintain);
        expect(
          (yield* pool.snapshot).containers.map(({ status }) => status),
        ).toEqual(["ready", "ready"]);
        yield* Fiber.join(maintaining);
        expect(test.platform.probed).toEqual([a.container]);
        expect(test.platform.stopped).toEqual([a.container]);
        expect((yield* pool.snapshot).containers).toMatchObject([
          { name: b.container, status: "ready" },
        ]);
      }),
    );
  });

  test("a compile that claims a container during its check keeps it", async () => {
    const test = harness();
    test.platform.probeDelayMs = 1000;
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const lease = yield* claimCold(request("a"));
        yield* pool.release(lease.id, { reusable: true });
        test.platform.failProbe.add(lease.container);
        const maintaining = yield* Effect.forkChild(pool.maintain);
        yield* settle;
        expect(test.platform.probed).toEqual([lease.container]);
        const claimed = yield* pool.claim(request("a"));
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(maintaining);
        expect(claimed.container).toBe(lease.container);
        expect(test.platform.stopped).toEqual([]);
      }),
    );
  });
});

describe("several compiles in one container", () => {
  const pair = Effect.gen(function* () {
    const a = yield* claimCold(request("a"));
    const pool = yield* PoolManagerService;
    const b = yield* pool.claim(request("b", { timeoutMs: 300_000 }));
    expect(b.container).toBe(a.container);
    return { a, b };
  });

  test("a container is replaced only after its other compiles end", async () => {
    const test = harness({ concurrency: 2, maxInstances: 2 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const { a, b } = yield* pair;
        yield* pool.release(a.id, { reusable: false });
        yield* pool.maintain;
        expect(test.platform.stopped).toEqual([]);
        expect((yield* pool.snapshot).containers[0]).toMatchObject({
          status: "draining",
          slots: [{ lease: null }, { lease: { id: b.id } }],
        });
        // Its free slot is never offered, even to its last caller.
        expect(
          (yield* Effect.flip(
            pool.claim(request("a", { container: a.container })),
          ))._tag,
        ).toBe("ResyncRequired");
        const next = yield* claimCold(request("a"));
        expect(next.container).not.toBe(a.container);
        yield* pool.release(b.id, { reusable: true });
        yield* settle;
        expect(test.platform.stopped).toEqual([a.container]);
      }),
    );
    expect(test.platform.started).toHaveLength(2);
  });

  test("an abandoned lease does not end the compile beside it", async () => {
    const test = harness({ concurrency: 2 });
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const { a, b } = yield* pair;
        yield* TestClock.adjust("5 minutes");
        yield* pool.maintain;
        expect(test.platform.stopped).toEqual([]);
        expect(yield* pool.cancel(a.id)).toBeNull();
        expect(yield* pool.cancel(b.id)).toMatchObject({ id: b.id });
        // Nor does it keep the container forever.
        yield* TestClock.adjust("5 minutes");
        yield* pool.maintain;
        expect(test.platform.stopped).toEqual([a.container]);
      }),
    );
  });

  test("a new pool instance finishes draining", async () => {
    const test = harness({ concurrency: 2 });
    const { a, b } = await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        const leases = yield* pair;
        yield* pool.release(leases.a.id, { reusable: false });
        return leases;
      }),
    );
    await run(
      test,
      Effect.gen(function* () {
        const pool = yield* PoolManagerService;
        yield* settle;
        expect(test.platform.stopped).toEqual([]);
        yield* pool.release(b.id, { reusable: true });
        yield* settle;
        expect(test.platform.stopped).toEqual([a.container]);
      }),
    );
  });
});

test("starting and stopping a container keeps the pool's process running", async () => {
  const test = harness();
  await run(
    test,
    Effect.gen(function* () {
      const pool = yield* PoolManagerService;
      const claim = yield* Effect.forkChild(pool.claim(request("a")));
      yield* settle;
      expect(test.kept).toHaveLength(1);
      const starting = yield* Effect.forkChild(test.kept[0]!);
      yield* settle;
      expect(starting.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(starting);
      const lease = yield* Fiber.join(claim);
      yield* pool.release(lease.id, { reusable: false });
      expect(test.kept).toHaveLength(2);
      yield* test.kept[1]!;
      expect(test.platform.stopped).toEqual([lease.container]);
    }),
  );
});

test("a new pool instance keeps leases and finishes interrupted starts and stops", async () => {
  const test = harness();
  test.platform.failStop = true;
  const held = await run(
    test,
    Effect.gen(function* () {
      const pool = yield* PoolManagerService;
      const a = yield* claimCold(request("a"));
      const b = yield* claimCold(request("b"));
      yield* pool.release(b.id, { reusable: false });
      yield* TestClock.adjust("10 seconds");
      yield* Effect.forkChild(pool.claim(request("c")));
      yield* settle;
      return { a, b };
    }),
  );
  expect(test.platform.started).toHaveLength(3);
  test.platform.failStop = false;
  await run(
    test,
    Effect.gen(function* () {
      const pool = yield* PoolManagerService;
      yield* settle;
      expect(test.platform.stopped).toEqual([held.b.container]);
      expect(test.platform.started).toHaveLength(4);
      yield* TestClock.adjust("1 second");
      expect(yield* pool.claim(request("d"))).toMatchObject({
        outcome: "spare",
      });
      yield* pool.release(held.a.id, { reusable: true });
      expect(
        yield* pool.claim(request("a", { container: held.a.container })),
      ).toMatchObject({ generation: 2 });
    }),
  );
});
