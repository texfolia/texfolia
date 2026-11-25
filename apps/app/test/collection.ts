import {
  sweepProjectSources as sweep,
  type SourceBucket,
} from "#/lib/storage/server";

import { collectProjectSources as collect } from "../src/lib/projects/project-source.server";

/** A time after everything the test did, so collection has no grace period. */
export const afterNow = () => new Date(Date.now() + 60_000);

export function collectProjectSources(
  options: Omit<Parameters<typeof collect>[0], "retiredBefore">,
) {
  return collect({ ...options, retiredBefore: afterNow() });
}

export function sweepProjectSources(options: {
  db: Parameters<typeof sweep>[0]["db"];
  bucket: SourceBucket;
}) {
  return sweep({ ...options, uploadedBefore: afterNow() });
}
