import { useEffect, useState, useSyncExternalStore } from "react";

import { listMentionCandidates } from "#/lib/mentions/mentions.functions";
import type { MentionCandidate } from "#/lib/mentions/tokens";
import { useProjectFiles } from "#/providers/project-files-provider";

const emptyCandidates: MentionCandidate[] = [];

/**
 * Loads the list of people with access to the current project for `@`-mention
 * autocomplete in review comments and the scratchpad.
 */
export function useMentionCandidates(projectId: string) {
  const files = useProjectFiles();
  const version = useSyncExternalStore(
    files.subscribe,
    () => files.getStatus().commentsVersion,
    () => undefined,
  );
  const [candidates, setCandidates] =
    useState<MentionCandidate[]>(emptyCandidates);

  useEffect(() => {
    let live = true;
    void listMentionCandidates({ data: { projectId } })
      .then((result) => {
        if (live) setCandidates(result.people);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId, version]);

  return candidates;
}
