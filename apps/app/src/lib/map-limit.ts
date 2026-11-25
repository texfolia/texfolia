/** How many binary files the workspace downloads at once. */
export const binaryFetchLimit = 6;

/**
 * Bounds work by the bytes it holds in memory as well as by how much of it
 * runs. One item larger than `maxBytes` still runs, alone.
 */
export class ByteBudget {
  private active = 0;
  private held = 0;
  private waiting: (() => void)[] = [];
  constructor(private limits: { limit: number; maxBytes: number }) {}

  /** Waits for room, then returns a function that gives it back. */
  async acquire(bytes: number) {
    const { limit, maxBytes } = this.limits;
    while (
      this.active >= limit ||
      (this.active > 0 && this.held + bytes > maxBytes)
    )
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    this.held += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.held -= bytes;
      for (const resume of this.waiting.splice(0)) resume();
    };
  }
}

/**
 * Maps `items` through `run` with at most `limit` calls in flight, keeping
 * results in input order. The first rejection rejects the whole call; work
 * already started is left to settle on its own. With `bytes`, calls in flight
 * also hold at most `maxBytes` together.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
  bytes?: { maxBytes: number; size: (item: T) => number },
): Promise<R[]> {
  const results: R[] = [];
  const budget = bytes && new ByteBudget({ limit, maxBytes: bytes.maxBytes });
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      const item = items[index] as T;
      const release = await budget?.acquire(bytes?.size(item) ?? 0);
      try {
        if (failed) return;
        results[index] = await run(item, index);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        release?.();
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  return results;
}
