import { useEffect, useMemo, useState } from "react";

import { debounce } from "#/lib/debounce";
import { draftSources, type FileDrafts } from "#/lib/workspace/file-drafts";

const followDelayMs = 150;

/**
 * The project's live text, read again once edits pause. Nothing is read or
 * followed while `active` is false.
 */
export function useDraftSources(
  drafts: FileDrafts,
  paths: ReadonlyMap<string, string>,
  active: boolean,
) {
  const [revision, setRevision] = useState(drafts.getRevision);
  useEffect(() => {
    if (!active) return;
    const follow = () => setRevision(drafts.getRevision());
    const debounced = debounce(follow, followDelayMs);
    const unsubscribe = drafts.subscribe(debounced.schedule);
    follow();
    return () => {
      unsubscribe();
      debounced.cancel();
    };
  }, [drafts, active]);
  return useMemo(
    () => (active ? draftSources(paths, drafts) : []),
    [drafts, paths, active, revision],
  );
}
