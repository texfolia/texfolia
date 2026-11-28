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

  test("bounds the bytes in flight, and runs an oversized item alone", async () => {
    let held = 0;
    const peaks: number[] = [];
    const results = await mapLimit(
      [4, 4, 4, 30, 1, 1],
      6,
      async (bytes) => {
        held += bytes;
        peaks.push(held);
        await new Promise((resolve) => setTimeout(resolve, 5));
        held -= bytes;
        return bytes;
      },
      { maxBytes: 10, size: (bytes) => bytes },
    );
    expect(results).toEqual([4, 4, 4, 30, 1, 1]);
    expect(peaks.filter((peak) => peak > 10)).toEqual([30]);
  });

  test("a failure releases its bytes, so the call still settles", async () => {
    const run = mapLimit(
      [8, 8, 8],
      3,
      async () => {
        throw new Error("boom");
      },
      { maxBytes: 10, size: (bytes) => bytes },
    );
    await expect(run).rejects.toThrow("boom");
  });
});
