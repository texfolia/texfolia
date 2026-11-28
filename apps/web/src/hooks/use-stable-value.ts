import { useRef } from "react";

/** Keeps the previous value while the next one equals it. */
export function useStableValue<T>(value: T, equal: (a: T, b: T) => boolean): T {
  const stable = useRef(value);
  if (stable.current !== value && !equal(stable.current, value))
    stable.current = value;
  return stable.current;
}
