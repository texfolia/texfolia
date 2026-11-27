import { collectProjectSources as collect } from "../src/lib/projects/project-source.server";

/** A time after everything the test did, so collection has no grace period. */
export const afterNow = () => new Date(Date.now() + 60_000);

export function collectProjectSources(
  options: Omit<Parameters<typeof collect>[0], "retiredBefore">,
) {
  return collect({ ...options, retiredBefore: afterNow() });
}
