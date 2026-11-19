import { describe, expect, test } from "bun:test";

import { mapLimit } from "./map-limit";

describe("mapLimit", () => {
  test("keeps input order and caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([30, 5, 20, 1, 10], 2, async (ms, index) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active--;
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  test("handles an empty list", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });

  test("rejects on the first failure and starts no more work", async () => {
    const started: number[] = [];
    const run = mapLimit([1, 2, 3, 4], 1, async (item) => {
      started.push(item);
      if (item === 2) throw new Error("boom");
      return item;
    });
    expect(run).rejects.toThrow("boom");
    await run.catch(() => {});
    expect(started).toEqual([1, 2]);
  });
});
