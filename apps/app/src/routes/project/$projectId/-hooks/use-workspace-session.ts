import { stopDocumentCaching } from "@texfolia/collaboration/browser";
import { useCallback, useEffect, useState } from "react";

import { getGitBranch } from "#/lib/git.functions";

/** Clearing the project's cached drafts or layout in another tab signs out here. */
export function useExitWhenStorageCleared(keys: string[]) {
  const watched = keys.join("\n");
  useEffect(() => {
    const keys = new Set(watched.split("\n"));
    const cleared = (event: StorageEvent) => {
      if (
        event.storageArea !== localStorage ||
        event.newValue !== null ||
        !event.key ||
        !keys.has(event.key)
      )
        return;
      stopDocumentCaching();
      window.location.replace("/");
    };
    window.addEventListener("storage", cleared);
    return () => window.removeEventListener("storage", cleared);
  }, [watched]);
}

export type GitBranchState =
  | { kind: "branch"; name: string | null }
  | { kind: "unavailable"; message: string };

/** The status bar's branch; a failed lookup or Git panel load marks Git unavailable. */
export function useGitBranch(projectId: string, ready: boolean) {
  const [state, setState] = useState<GitBranchState>({
    kind: "branch",
    name: null,
  });
  const reportBranch = useCallback(
    (name: string | null) => setState({ kind: "branch", name }),
    [],
  );
  const reportFailure = useCallback(
    (error: unknown) => {
      console.error("Git status unavailable", { projectId, error });
      setState({
        kind: "unavailable",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Could not load git.",
      });
    },
    [projectId],
  );
  useEffect(() => {
    let active = true;
    if (ready)
      void getGitBranch({ data: { projectId } }).then(
        (name) => {
          if (active) reportBranch(name);
        },
        (error: unknown) => {
          if (active) reportFailure(error);
        },
      );
    return () => {
      active = false;
    };
  }, [ready, projectId, reportBranch, reportFailure]);
  return { state, reportBranch, reportFailure };
}
