import { useEffect, useState } from "react";

import { stopDocumentCaching } from "#/lib/collaboration/cache";
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

export function useGitBranch(projectId: string, ready: boolean) {
  const [branch, setBranch] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (ready)
      void getGitBranch({ data: { projectId } })
        .then((branch) => {
          if (active) setBranch(branch);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [ready, projectId]);
  return [branch, setBranch] as const;
}
