export type GitSyncedSnapshot = {
  projectId: string;
  sourcesVersion: string;
  gitVersion: string | undefined;
  /** `null` while the initial status request is still in flight. */
  hasRepo: boolean | null;
  failed: boolean;
};

export type GitRefreshCheck = {
  visible: boolean;
  busy: boolean;
  projectId: string;
  sourcesVersion: string;
  gitVersion: string | undefined;
  hasUnsavedDrafts: boolean;
  reopened: boolean;
  synced: GitSyncedSnapshot | null;
};

export type GitRefreshDecision =
  | { kind: "skip" }
  | { kind: "hydrate"; synced: GitSyncedSnapshot }
  | { kind: "refresh" };

/**
 * Decides whether the Git panel should request a fresh status from the server.
 * Refreshes happen only while visible and only when the panel has not loaded,
 * failed previously and was reopened, or observes a source/repository change.
 */
export function decideGitStatusRefresh({
  visible,
  busy,
  projectId,
  sourcesVersion,
  gitVersion,
  hasUnsavedDrafts,
  reopened,
  synced,
}: GitRefreshCheck): GitRefreshDecision {
  if (!visible || busy) return { kind: "skip" };
  if (!synced || synced.projectId !== projectId) return { kind: "refresh" };
  const gitChanged =
    synced.gitVersion !== undefined &&
    gitVersion !== undefined &&
    gitVersion !== synced.gitVersion;
  const repoPresenceChanged =
    synced.gitVersion === undefined &&
    gitVersion !== undefined &&
    synced.hasRepo !== null &&
    !synced.failed &&
    Boolean(gitVersion) !== synced.hasRepo;
  const sourcesChanged = sourcesVersion !== synced.sourcesVersion;
  if (gitChanged || repoPresenceChanged) return { kind: "refresh" };
  if (synced.hasRepo !== false && sourcesChanged) return { kind: "refresh" };
  if (reopened && (synced.failed || (synced.hasRepo && hasUnsavedDrafts)))
    return { kind: "refresh" };
  if (
    (synced.gitVersion === undefined && gitVersion !== undefined) ||
    (synced.hasRepo === false && sourcesChanged)
  )
    return {
      kind: "hydrate",
      synced: {
        ...synced,
        sourcesVersion,
        gitVersion: gitVersion ?? synced.gitVersion,
      },
    };
  return { kind: "skip" };
}
