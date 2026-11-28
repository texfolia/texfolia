import { expect, test } from "bun:test";

import {
  decideGitStatusRefresh,
  type GitSyncedSnapshot,
} from "./git-status-sync";

const projectId = "11111111-1111-4111-8111-111111111111";

const syncedLinked: GitSyncedSnapshot = {
  projectId,
  sourcesVersion: "v1",
  gitVersion: "git/1.json",
  hasRepo: true,
  failed: false,
};

test("never refreshes while hidden or busy", () => {
  expect(
    decideGitStatusRefresh({
      visible: false,
      busy: false,
      projectId,
      sourcesVersion: "v2",
      gitVersion: "git/2.json",
      hasUnsavedDrafts: true,
      reopened: false,
      synced: null,
    }),
  ).toEqual({ kind: "skip" });

  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: true,
      projectId,
      sourcesVersion: "v2",
      gitVersion: "git/2.json",
      hasUnsavedDrafts: true,
      reopened: true,
      synced: syncedLinked,
    }),
  ).toEqual({ kind: "skip" });
});

test("loads once when first visible and stays idle when nothing changes", () => {
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: undefined,
      hasUnsavedDrafts: false,
      reopened: true,
      synced: null,
    }),
  ).toEqual({ kind: "refresh" });

  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: syncedLinked,
    }),
  ).toEqual({ kind: "skip" });
});

test("hydrates initial gitVersion without triggering a redundant status read", () => {
  const initialSynced: GitSyncedSnapshot = {
    projectId,
    sourcesVersion: "v1",
    gitVersion: undefined,
    hasRepo: true,
    failed: false,
  };
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: initialSynced,
    }),
  ).toEqual({
    kind: "hydrate",
    synced: { ...initialSynced, gitVersion: "git/1.json" },
  });

  // Also hydrates without refresh while initial status is still in flight.
  const inFlight: GitSyncedSnapshot = {
    projectId,
    sourcesVersion: "v1",
    gitVersion: undefined,
    hasRepo: null,
    failed: false,
  };
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: inFlight,
    }),
  ).toEqual({
    kind: "hydrate",
    synced: { ...inFlight, gitVersion: "" },
  });
});

test("refreshes when repo presence changes during initial metadata hydration", () => {
  const unlinkedBeforeHydration: GitSyncedSnapshot = {
    projectId,
    sourcesVersion: "v1",
    gitVersion: undefined,
    hasRepo: false,
    failed: false,
  };
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/new.json",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: unlinkedBeforeHydration,
    }),
  ).toEqual({ kind: "refresh" });
});

test("refreshes when project files change for a linked repo, but not for an unlinked project", () => {
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v2",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: syncedLinked,
    }),
  ).toEqual({ kind: "refresh" });

  const unlinked: GitSyncedSnapshot = {
    projectId,
    sourcesVersion: "v1",
    gitVersion: "",
    hasRepo: false,
    failed: false,
  };
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v2",
      gitVersion: "",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: unlinked,
    }),
  ).toEqual({
    kind: "hydrate",
    synced: { ...unlinked, sourcesVersion: "v2" },
  });
});

test("refreshes when gitVersion changes on the server (collaborator or assistant action)", () => {
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/2.json",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: syncedLinked,
    }),
  ).toEqual({ kind: "refresh" });

  // Unlinked project suddenly linked by another session.
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: {
        projectId,
        sourcesVersion: "v1",
        gitVersion: "",
        hasRepo: false,
        failed: false,
      },
    }),
  ).toEqual({ kind: "refresh" });
});

test("does not loop after a failed status read, but retries when reopened", () => {
  const failed: GitSyncedSnapshot = { ...syncedLinked, failed: true };
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: false,
      reopened: false,
      synced: failed,
    }),
  ).toEqual({ kind: "skip" });

  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: false,
      reopened: true,
      synced: failed,
    }),
  ).toEqual({ kind: "refresh" });
});

test("refreshes on reopen when local unsaved drafts exist, but skips if clean and unchanged", () => {
  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: true,
      reopened: true,
      synced: syncedLinked,
    }),
  ).toEqual({ kind: "refresh" });

  expect(
    decideGitStatusRefresh({
      visible: true,
      busy: false,
      projectId,
      sourcesVersion: "v1",
      gitVersion: "git/1.json",
      hasUnsavedDrafts: false,
      reopened: true,
      synced: syncedLinked,
    }),
  ).toEqual({ kind: "skip" });
});
