import { describe, expect, test } from "bun:test";

import {
  containersFor,
  desiredSize,
  nextSpare,
  recordDemand,
  retainedSize,
} from "../src/autoscaler";
import { poolSettings } from "../src/config";

const settings = poolSettings({});
const window = { startedAt: 0, hits: 0, misses: 0, peakQueued: 0 };

test("defaults scale to zero, cap at 20, run one compile per container, and drain after 10 minutes", () => {
  expect(settings).toMatchObject({
    minWarm: 0,
    maxInstances: 20,
    concurrency: 1,
    idleMs: 600_000,
  });
  expect(
    poolSettings({
      POOL_MIN_WARM: "3",
      POOL_MAX_INSTANCES: "8",
      POOL_CONCURRENCY: "2",
      POOL_IDLE_MS: "5000",
      POOL_MAX_QUEUED: "7",
    }),
  ).toMatchObject({
    minWarm: 3,
    maxInstances: 8,
    concurrency: 2,
    idleMs: 5000,
    maxQueued: 7,
  });
  expect(
    poolSettings({ POOL_MIN_WARM: "30", POOL_MAX_INSTANCES: "8" }).minWarm,
  ).toBe(8);
  for (const value of ["-1", "1.5", "many"])
    expect(() => poolSettings({ POOL_MIN_WARM: value })).toThrow();
});

describe("desired size", () => {
  test.each([
    [{ activeLeases: 0, queuedRequests: 0, spare: 0 }, 0],
    [{ activeLeases: 1, queuedRequests: 0, spare: 0 }, 1],
    [{ activeLeases: 3, queuedRequests: 4, spare: 0 }, 7],
    [{ activeLeases: 3, queuedRequests: 4, spare: 2 }, 9],
    [{ activeLeases: 15, queuedRequests: 30, spare: 4 }, 20],
  ])("%j needs %i containers", (demand, expected) => {
    expect(desiredSize(demand, settings)).toBe(expected);
  });

  test("keeps a configured warm floor and packs containers by concurrency", () => {
    expect(
      desiredSize(
        { activeLeases: 0, queuedRequests: 0, spare: 0 },
        { ...settings, minWarm: 2 },
      ),
    ).toBe(2);
    expect(
      containersFor(
        { activeLeases: 3, queuedRequests: 2 },
        { ...settings, concurrency: 4 },
      ),
    ).toBe(2);
  });
});

test("spare capacity grows under sustained misses or queueing and then decays to zero", () => {
  expect(nextSpare(0, { ...window, hits: 9, misses: 1 }, settings)).toBe(0);
  expect(nextSpare(0, { ...window, hits: 90, misses: 2 }, settings)).toBe(0);
  let spare = 0;
  const sizes = [];
  for (let index = 0; index < 6; index++) {
    spare = nextSpare(spare, { ...window, hits: 2, misses: 2 }, settings);
    sizes.push(spare);
  }
  expect(sizes).toEqual([1, 2, 4, 8, 16, 20]);
  expect(nextSpare(0, { ...window, peakQueued: 2 }, settings)).toBe(1);
  expect(nextSpare(2, window, settings)).toBe(1);
  expect(nextSpare(0, window, settings)).toBe(0);
});

test("surplus containers are kept until the idle window passes without needing them", () => {
  let samples = recordDemand([], 12, 0, settings);
  samples = recordDemand(samples, 1, 30_000, settings);
  expect(samples).toEqual([{ at: 30_000, containers: 12 }]);
  samples = recordDemand(samples, 1, 300_000, settings);
  expect(retainedSize(1, samples, settings)).toBe(12);
  samples = recordDemand(samples, 1, 630_000, settings);
  expect(retainedSize(1, samples, settings)).toBe(1);
  samples = recordDemand(samples, 0, 1_230_000, settings);
  expect(samples).toEqual([]);
  expect(retainedSize(0, samples, settings)).toBe(0);
  expect(retainedSize(25, samples, settings)).toBe(20);
});
