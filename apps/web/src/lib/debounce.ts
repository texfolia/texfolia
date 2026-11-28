/** Runs the last scheduled call once scheduling has paused for `delayMs`. */
export function debounce<A extends unknown[]>(
  run: (...args: A) => void,
  delayMs: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: A | undefined;
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    const args = latest;
    latest = undefined;
    if (args) run(...args);
  }
  return {
    schedule(...args: A) {
      latest = args;
      clearTimeout(timer);
      timer = setTimeout(flush, delayMs);
    },
    /** Runs a scheduled call now; does nothing when none is waiting. */
    flush,
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      latest = undefined;
    },
  };
}
