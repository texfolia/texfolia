import { useState } from "react";

/** Whether `condition` has been true at least once since this mounted. */
export function useHasBeen(condition: boolean) {
  const [seen, setSeen] = useState(condition);
  if (condition && !seen) setSeen(true);
  return seen || condition;
}
