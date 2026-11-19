/** How many binary files the workspace downloads at once. */
export const binaryFetchLimit = 6;

/**
 * Maps `items` through `run` with at most `limit` calls in flight, keeping
 * results in input order. The first rejection rejects the whole call; work
 * already started is left to settle on its own.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker),
  );
  return results;
}
