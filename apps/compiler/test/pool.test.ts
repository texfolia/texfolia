import { describe, expect, test } from "bun:test";

import { poolSettings, type PoolSettings } from "../src/config";
import type { ContainerPlatform } from "../src/containers";
import {
  createPoolManager,
  type ClaimRequest,
  type ClaimResult,
  type Lease,
  type PoolClock,
} from "../src/pool";

class FakeClock implements PoolClock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now() {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }

  sleep(ms: number) {
    return new Promise<void>((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  async flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  async advance(ms: number) {
    const target = this.time + ms;
    await this.flush();
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, entry] of this.timers) {
        if (entry.at <= target && entry.at < nextAt) {
          nextAt = entry.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const entry = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = entry.at;
      entry.callback();
      await this.flush();
    }
    this.time = target;
    await this.flush();
  }
}

type Platform = {
  started: string[];
  stopped: string[];
  startDelayMs: number;
  failStart: boolean;
  failStop: boolean;
};

function harness(overrides: Partial<PoolSettings> = {}) {
  const clock = new FakeClock();
  const platform: Platform = {
    started: [],
    stopped: [],
    startDelayMs: 1000,
    failStart: false,
    failStop: false,
  };
  let saved: string | null = null;
  const kept: Promise<unknown>[] = [];
  const containers: ContainerPlatform = {
    async start(name) {
      platform.started.push(name);
      await clock.sleep(platform.startDelayMs);
      if (platform.failStart) throw new Error("start failed");
    },
    async stop(name) {
      if (platform.failStop) throw new Error("stop failed");
      platform.stopped.push(name);
    },
    fetch: () => Promise.reject(new Error("The pool never compiles")),
  };
  const open = () =>
    createPoolManager({
      settings: { ...poolSettings({}), ...overrides },
      containers,
      store: {
        load: () => saved,
        save: (value) => {
          saved = value;
        },
      },
      waitUntil: (task) => {
        kept.push(task);
      },
      clock,
    });
  const pool = open();
  return { clock, platform, pool, open, kept, saved: () => saved };
}

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

function expectLease(result: ClaimResult): Lease {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected lease, got ${result.code}`);
  return result.lease;
}

function expectFailure(result: ClaimResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected claim failure");
  return result;
}

async function claimCold(
  testHarness: ReturnType<typeof harness>,
  input: ClaimRequest,
) {
  const pending = testHarness.pool.claim(input);
  await testHarness.clock.advance(testHarness.platform.startDelayMs);
  return expectLease(await pending);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("scale from and to zero", () => {
  test("an idle pool runs nothing, and maintenance starts nothing", async () => {
    const h = harness();
    await h.pool.maintain();
    await h.clock.advance(HOUR);
    await h.pool.maintain();
    expect(h.pool.idle()).toBe(true);
    expect(h.platform.started).toEqual([]);
  });

  test("the first claim starts one container; the next claim reuses it at once", async () => {
    const h = harness();
    const first = await claimCold(h, request("a"));
    expect(first).toMatchObject({
      outcome: "cold",
      waitMs: 1000,
      generation: 1,
    });
    await h.pool.release(first.id, { reusable: true });
    const second = expectLease(await h.pool.claim(request("a")));
    expect(second).toMatchObject({
      container: first.container,
      outcome: "affinity",
      waitMs: 0,
      generation: 2,
    });
    await h.pool.release(second.id, { reusable: true });
    const third = expectLease(await h.pool.claim(request("b")));
    expect(third).toMatchObject({
      container: first.container,
      outcome: "spare",
      generation: 3,
    });
    expect(h.platform.started).toHaveLength(1);
  });

  test("the pool drains exactly one idle window after its last lease", async () => {
    const h = harness();
    const lease = await claimCold(h, request("a"));
    await h.clock.advance(2 * MINUTE);
    await h.pool.release(lease.id, { reusable: true });
    for (let index = 0; index < 9; index++) {
      await h.clock.advance(MINUTE);
      await h.pool.maintain();
      expect(h.platform.stopped).toEqual([]);
    }
    await h.clock.advance(MINUTE);
    await h.pool.maintain();
    await h.clock.flush();
    expect(h.platform.stopped).toEqual([lease.container]);
    expect(h.pool.idle()).toBe(true);
  });

  test("a warm floor survives the drain", async () => {
    const h = harness({ minWarm: 2 });
    await h.pool.maintain();
    await h.clock.advance(1000);
    await h.clock.advance(HOUR);
    await h.pool.maintain();
    expect(h.pool.snapshot().containers.map((c) => c.status)).toEqual([
      "ready",
      "ready",
    ]);
    expect(h.platform.stopped).toEqual([]);
  });
});

describe("scale up", () => {
  test("a burst starts one container per waiting compile, up to the maximum, and queues the rest", async () => {
    const h = harness();
    const claims = Array.from({ length: 25 }, (_, index) =>
      h.pool.claim(request(`p${index}`)),
    );
    await h.clock.flush();
    expect(h.platform.started).toHaveLength(20);
    await h.clock.advance(1000);
    expect(h.pool.snapshot().queued).toBe(5);
    const first = expectLease(await claims[0]!);
    await h.pool.release(first.id, { reusable: true });
    const queued = expectLease(await claims[20]!);
    expect(queued.container).toBe(first.container);
    expect(h.pool.snapshot().queued).toBe(4);
    expect(h.platform.started).toHaveLength(20);
  });

  test("a released container serves a waiting compile before its own cold start finishes", async () => {
    const h = harness();
    h.platform.startDelayMs = 30_000;
    const lease = await claimCold(h, request("a"));
    const second = h.pool.claim(request("b"));
    await h.clock.advance(1000);
    await h.pool.release(lease.id, { reusable: true });
    expect(expectLease(await second)).toMatchObject({
      container: lease.container,
      waitMs: 1000,
    });
  });

  test("repeated misses add spare capacity beyond the current demand", async () => {
    const h = harness();
    const held = [
      await claimCold(h, request("a")),
      await claimCold(h, request("b")),
      await claimCold(h, request("c")),
    ];
    await h.clock.advance(MINUTE);
    await h.pool.maintain();
    await h.clock.advance(1000);
    expect(h.pool.snapshot().spare).toBe(1);
    expect(h.platform.started).toHaveLength(4);
    expect(expectLease(await h.pool.claim(request("d")))).toMatchObject({
      outcome: "spare",
    });
    // Quiet windows give the spare back.
    for (const lease of held)
      await h.pool.release(lease.id, { reusable: true });
    await h.clock.advance(MINUTE);
    await h.pool.maintain();
    expect(h.pool.snapshot().spare).toBe(0);
  });

  test("concurrency above one fills a container before starting another", async () => {
    const h = harness({ concurrency: 2 });
    const first = await claimCold(h, request("a"));
    const second = expectLease(await h.pool.claim(request("b")));
    expect(second.container).toBe(first.container);
    expect([first.slot, second.slot]).toEqual([0, 1]);
    void h.pool.claim(request("c"));
    await h.clock.flush();
    expect(h.platform.started).toHaveLength(2);
  });
});

describe("claims", () => {
  test("a caller returns to its own container, and a stranger takes the one idle longest", async () => {
    const h = harness();
    const a = await claimCold(h, request("a"));
    const b = await claimCold(h, request("b"));
    await h.pool.release(a.id, { reusable: true });
    await h.clock.advance(1000);
    await h.pool.release(b.id, { reusable: true });
    const again = expectLease(await h.pool.claim(request("b")));
    expect(again).toMatchObject({
      container: b.container,
      outcome: "affinity",
    });
    await h.pool.release(again.id, { reusable: true });
    expect(expectLease(await h.pool.claim(request("c")))).toMatchObject({
      container: a.container,
      outcome: "spare",
    });
  });

  test("an incremental claim gets its exact container or a resync, never another one", async () => {
    const h = harness();
    const a = await claimCold(h, request("a"));
    await h.pool.release(a.id, { reusable: true });
    const own = expectLease(
      await h.pool.claim(request("a", { container: a.container })),
    );
    expect(own).toMatchObject({
      container: a.container,
      outcome: "affinity",
    });
    // It waits briefly while its previous compile gives the container back.
    const waiting = h.pool.claim(request("a", { container: a.container }));
    await h.clock.advance(100);
    await h.pool.release(own.id, { reusable: true });
    const next = expectLease(await waiting);
    expect(next).toMatchObject({ container: a.container, waitMs: 100 });
    const late = h.pool.claim(request("a", { container: a.container }));
    await h.clock.advance(2000);
    expect(expectFailure(await late).code).toBe("resync");
    await h.pool.release(next.id, { reusable: true });
    const stranger = expectLease(await h.pool.claim(request("b")));
    await h.pool.release(stranger.id, { reusable: true });
    for (const container of [a.container, "compiler-gone"])
      expect(
        expectFailure(await h.pool.claim(request("a", { container }))).code,
      ).toBe("resync");
    expect(h.platform.started).toHaveLength(1);
  });

  test("higher priority waits less; equal priority is first come, first served", async () => {
    const h = harness({ maxInstances: 1 });
    let held = await claimCold(h, request("holder"));
    const order: string[] = [];
    const started: Promise<void>[] = [];
    for (const input of [
      request("low-1"),
      request("low-2"),
      request("high-1", { priority: 1 }),
      request("high-2", { priority: 1 }),
    ]) {
      started.push(
        h.pool.claim(input).then((result) => {
          const lease = expectLease(result);
          order.push(input.affinity);
          held = lease;
        }),
      );
      await h.clock.flush();
    }
    for (let index = 0; index < 4; index++) {
      await h.pool.release(held.id, { reusable: true });
      await h.clock.flush();
    }
    await Promise.all(started);
    expect(order).toEqual(["high-1", "high-2", "low-1", "low-2"]);
  });

  test("a full queue refuses work and a stuck claim times out without leaking a place", async () => {
    const h = harness({ maxInstances: 1, maxQueued: 1 });
    const held = await claimCold(h, request("a"));
    const waiting = h.pool.claim(request("b"));
    await h.clock.flush();
    expect(expectFailure(await h.pool.claim(request("c"))).code).toBe(
      "saturated",
    );
    await h.clock.advance(60_000);
    expect(expectFailure(await waiting).code).toBe("unavailable");
    expect(h.pool.snapshot().queued).toBe(0);
    await h.pool.release(held.id, { reusable: true });
    expect(h.pool.snapshot().containers[0]?.slots[0]?.lease).toBeNull();
  });

  test("an aborted or cancelled wait gives up its place", async () => {
    const h = harness({ maxInstances: 1 });
    const held = await claimCold(h, request("a"));
    const controller = new AbortController();
    const aborted = h.pool.claim(request("b"), controller.signal);
    const input = request("c");
    const cancelled = h.pool.claim(input);
    await h.clock.flush();
    expect(h.pool.snapshot().queued).toBe(2);
    controller.abort();
    expect(expectFailure(await aborted).code).toBe("cancelled");
    expect(await h.pool.cancel(input.id)).toBeNull();
    expect(expectFailure(await cancelled).code).toBe("cancelled");
    expect(h.pool.snapshot().queued).toBe(0);
    await h.pool.release(held.id, { reusable: true });
    expect(expectLease(await h.pool.claim(request("d")))).toMatchObject({
      container: held.container,
    });
  });

  test("a cancel that overtakes its claim still wins", async () => {
    const h = harness();
    const input = request("a");
    expect(await h.pool.cancel(input.id)).toBeNull();
    expect(expectFailure(await h.pool.claim(input)).code).toBe("cancelled");
    expect(await claimCold(h, request("a"))).toMatchObject({
      outcome: "cold",
    });
    expect(h.platform.started).toHaveLength(1);
  });

  test("a compile ID cannot hold two leases", async () => {
    const h = harness();
    const input = request("a");
    await claimCold(h, input);
    expect(expectFailure(await h.pool.claim(input)).code).toBe("unavailable");
  });

  test("a cancel leaves a lease to its compile and names the container to stop", async () => {
    const h = harness();
    const held = await claimCold(h, request("a"));
    expect(await h.pool.cancel(held.id)).toMatchObject({
      container: held.container,
      slot: held.slot,
      generation: 1,
    });
    const [container] = h.pool.snapshot().containers;
    expect(container?.slots[0]?.lease?.id).toBe(held.id);
  });

  test("a cancel that meets a grant either prevents it or reports it", async () => {
    const h = harness({ maxInstances: 1 });
    const held = await claimCold(h, request("a"));
    const input = request("b");
    const waiting = h.pool.claim(input);
    await h.clock.flush();
    // Granted, but its claim has not yet been told.
    await h.pool.release(held.id, { reusable: true });
    expect(await h.pool.cancel(input.id)).toMatchObject({
      container: held.container,
    });
    expect(expectLease(await waiting)).toMatchObject({ generation: 2 });
  });

  test("early cancels are forgotten oldest first", async () => {
    const h = harness();
    const inputs = Array.from({ length: 1025 }, () => request("a"));
    for (const { id } of inputs) await h.pool.cancel(id);
    for (const input of [inputs[1]!, inputs[1024]!])
      expect(expectFailure(await h.pool.claim(input)).code).toBe("cancelled");
    expect(await claimCold(h, inputs[0]!)).toMatchObject({ generation: 1 });
  });

  test("a wait that ends on its own does not cancel its compile ID", async () => {
    const h = harness();
    const held = await claimCold(h, request("a"));
    const input = request("a", { container: held.container });
    const waiting = h.pool.claim(input);
    await h.clock.advance(2000);
    expect(expectFailure(await waiting).code).toBe("resync");
    await h.pool.release(held.id, { reusable: true });
    expect(expectLease(await h.pool.claim(input))).toMatchObject({
      generation: 2,
    });
  });
});

describe("failures", () => {
  test("a released container is offered again synchronously without platform calls", async () => {
    const h = harness();
    const lease = await claimCold(h, request("a"));
    await h.pool.release(lease.id, { reusable: true });
    expect(expectLease(await h.pool.claim(request("b"))).container).toBe(
      lease.container,
    );
    expect(h.platform.stopped).toEqual([]);
  });

  test("an unusable container is replaced while compiles wait", async () => {
    const h = harness({ maxInstances: 2 });
    const lease = await claimCold(h, request("a"));
    await claimCold(h, request("b"));
    const waiting = h.pool.claim(request("c"));
    await h.clock.flush();
    await h.pool.release(lease.id, { reusable: false });
    await h.clock.flush();
    expect(h.platform.stopped).toEqual([lease.container]);
    await h.clock.advance(1000);
    const next = expectLease(await waiting);
    expect(next.container).not.toBe(lease.container);
  });

  test("claims fail fast when no container can start, and the pool recovers", async () => {
    const h = harness();
    h.platform.failStart = true;
    const claim = h.pool.claim(request("a"));
    await h.clock.advance(1000);
    expect(expectFailure(await claim).code).toBe("unavailable");
    await h.clock.flush();
    expect(h.pool.idle()).toBe(true);
    h.platform.failStart = false;
    expect(await claimCold(h, request("a"))).toMatchObject({ outcome: "cold" });
  });

  test("a container whose stop fails still counts and is stopped later", async () => {
    const h = harness({ maxInstances: 1 });
    h.platform.failStop = true;
    const lease = await claimCold(h, request("a"));
    await h.pool.release(lease.id, { reusable: false });
    await h.clock.advance(10_000);
    expect(h.pool.snapshot().containers).toMatchObject([
      { name: lease.container, status: "stopping" },
    ]);
    const waiting = h.pool.claim(request("b"));
    await h.clock.flush();
    expect(h.platform.started).toHaveLength(1);
    h.platform.failStop = false;
    await h.pool.maintain();
    await h.clock.advance(1000);
    expectLease(await waiting);
    expect(h.platform.started).toHaveLength(2);
  });

  test("an abandoned lease is replaced after its own deadline", async () => {
    const h = harness();
    const lease = await claimCold(h, request("a", { timeoutMs: 15_000 }));
    await h.clock.advance(254_000);
    await h.pool.maintain();
    expect(h.platform.stopped).toEqual([]);
    await h.clock.advance(1000);
    await h.pool.maintain();
    expect(h.platform.stopped).toEqual([lease.container]);
    // The late release of that lease changes nothing.
    await h.pool.release(lease.id, { reusable: true });
    expect(h.pool.snapshot().containers).toEqual([]);
  });

  test("maintenance leaves idle containers alone instead of probing them", async () => {
    const h = harness();
    const lease = await claimCold(h, request("a"));
    await h.pool.release(lease.id, { reusable: true });
    await h.clock.advance(MINUTE);
    await h.pool.maintain();
    expect(h.platform.stopped).toEqual([]);
    expect(h.pool.snapshot().containers).toMatchObject([
      { name: lease.container, status: "ready" },
    ]);
  });
});

describe("several compiles in one container", () => {
  async function pair(h: ReturnType<typeof harness>) {
    const a = await claimCold(h, request("a"));
    const b = expectLease(
      await h.pool.claim(request("b", { timeoutMs: 300_000 })),
    );
    expect(b.container).toBe(a.container);
    return { a, b };
  }

  test("a container is replaced only after its other compiles end", async () => {
    const h = harness({ concurrency: 2, maxInstances: 2 });
    const { a, b } = await pair(h);
    await h.pool.release(a.id, { reusable: false });
    await h.pool.maintain();
    expect(h.platform.stopped).toEqual([]);
    expect(h.pool.snapshot().containers[0]).toMatchObject({
      status: "draining",
      slots: [{ lease: null }, { lease: { id: b.id } }],
    });
    // Its free slot is never offered, even to its last caller.
    expect(
      expectFailure(
        await h.pool.claim(request("a", { container: a.container })),
      ).code,
    ).toBe("resync");
    const next = await claimCold(h, request("a"));
    expect(next.container).not.toBe(a.container);
    await h.pool.release(b.id, { reusable: true });
    await h.clock.flush();
    expect(h.platform.stopped).toEqual([a.container]);
    expect(h.platform.started).toHaveLength(2);
  });

  test("an abandoned lease does not end the compile beside it", async () => {
    const h = harness({ concurrency: 2 });
    const { a, b } = await pair(h);
    await h.clock.advance(5 * MINUTE);
    await h.pool.maintain();
    expect(h.platform.stopped).toEqual([]);
    expect(await h.pool.cancel(a.id)).toBeNull();
    expect(await h.pool.cancel(b.id)).toMatchObject({ id: b.id });
    // Nor does it keep the container forever.
    await h.clock.advance(5 * MINUTE);
    await h.pool.maintain();
    expect(h.platform.stopped).toEqual([a.container]);
  });

  test("a new pool instance finishes draining", async () => {
    const h = harness({ concurrency: 2 });
    const { a, b } = await pair(h);
    await h.pool.release(a.id, { reusable: false });
    h.pool.dispose();
    const reopened = h.open();
    await h.clock.flush();
    expect(h.platform.stopped).toEqual([]);
    await reopened.release(b.id, { reusable: true });
    await h.clock.flush();
    expect(h.platform.stopped).toEqual([a.container]);
  });
});

test("starting and stopping a container keeps the pool's process running", async () => {
  const h = harness();
  const claim = h.pool.claim(request("a"));
  await h.clock.flush();
  expect(h.kept).toHaveLength(1);
  let startDone = false;
  void h.kept[0]!.then(() => {
    startDone = true;
  });
  await h.clock.flush();
  expect(startDone).toBe(false);
  await h.clock.advance(1000);
  await h.kept[0];
  expect(startDone).toBe(true);
  const lease = expectLease(await claim);
  await h.pool.release(lease.id, { reusable: false });
  expect(h.kept).toHaveLength(2);
  await h.kept[1];
  expect(h.platform.stopped).toEqual([lease.container]);
});

test("a new pool instance keeps leases and finishes interrupted starts and stops", async () => {
  const h = harness();
  h.platform.failStop = true;
  const a = await claimCold(h, request("a"));
  const b = await claimCold(h, request("b"));
  await h.pool.release(b.id, { reusable: false });
  await h.clock.advance(10_000);
  void h.pool.claim(request("c"));
  await h.clock.flush();
  expect(h.platform.started).toHaveLength(3);
  h.pool.dispose();
  h.platform.failStop = false;
  const reopened = h.open();
  await h.clock.flush();
  expect(h.platform.stopped).toEqual([b.container]);
  expect(h.platform.started).toHaveLength(4);
  await h.clock.advance(1000);
  expect(expectLease(await reopened.claim(request("d")))).toMatchObject({
    outcome: "spare",
  });
  await reopened.release(a.id, { reusable: true });
  expect(
    expectLease(await reopened.claim(request("a", { container: a.container }))),
  ).toMatchObject({ generation: 2 });
});
