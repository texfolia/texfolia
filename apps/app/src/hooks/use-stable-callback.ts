import { useInsertionEffect, useRef, useState } from "react";

type Action = (...args: never[]) => unknown;

/**
 * Returns functions that never change identity and always run the latest
 * version. Call them from events and effects, not while rendering.
 */
export function useStableActions<T extends Record<string, Action>>(
  actions: T,
): T {
  const latest = useRef(actions);
  // Before layout effects, so children's effects already see the new version.
  useInsertionEffect(() => {
    latest.current = actions;
  });
  const [stable] = useState(
    () =>
      Object.fromEntries(
        Object.keys(actions).map((key) => [
          key,
          (...args: never[]) => latest.current[key]?.(...args),
        ]),
      ) as T,
  );
  return stable;
}

/** One function like those of `useStableActions`. */
export function useStableCallback<T extends Action>(callback: T): T {
  return useStableActions({ callback }).callback;
}
