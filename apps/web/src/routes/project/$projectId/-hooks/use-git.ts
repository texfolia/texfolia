import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

import { connectGitAccount } from "#/components/git-remote-form";
import type { GitAction, GitProvider, GitResult } from "#/lib/git";
import { gitAction } from "#/lib/git/git.functions";
import {
  readSession,
  removeSession,
  writeSession,
} from "#/lib/session-storage";
import { useProjectFiles } from "#/providers/project-files-provider";
import {
  useWorkspace,
  useWorkspaceActions,
} from "#/providers/workspace-provider";

import {
  decideGitStatusRefresh,
  type GitSyncedSnapshot,
} from "./git-status-sync";

type GitRequest = Parameters<typeof gitAction>[0]["data"]["action"];
type GitError = { source: "status" | "action"; message: string };
/** What runs now, if anything. */
type Busy = GitAction["kind"] | "generate" | "authorize" | "";

function usePageVisible() {
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** The project's repository: its status, and the actions on it. */
export function useGit(visible: boolean) {
  const { projectId, drafts, reportGitBranch, reportGitFailure } =
    useWorkspaceActions();
  const { canWrite, collaboration } = useWorkspace();
  const files = useProjectFiles();
  const sourcesVersion = useSyncExternalStore(
    files.subscribe,
    () => files.getStatus().sourcesVersion,
    () => files.getStatus().sourcesVersion,
  );
  const gitVersion = useSyncExternalStore(
    files.subscribe,
    () => files.getStatus().gitVersion,
    () => files.getStatus().gitVersion,
  );
  const [result, setResult] = useState<GitResult | null>(null);
  const [busy, setBusy] = useState<Busy>("");
  const [error, setError] = useState<GitError | null>(null);
  const [notice, setNotice] = useState("");
  const [message, setMessage] = useState("");
  const messageKey = `texfolia.git-message.${projectId}`;
  useEffect(() => {
    setMessage(readSession(messageKey) ?? "");
  }, [messageKey]);
  function changeMessage(value: string) {
    setMessage(value);
    writeSession(messageKey, value);
  }
  const panelVisible = usePageVisible() && visible;
  const request = useRef(0);
  const synced = useRef<GitSyncedSnapshot | null>(null);
  const wasVisible = useRef(false);
  const diffOpen = Boolean(result?.diff);

  useEffect(() => {
    if (result) reportGitBranch(result.status.branch);
  }, [result, reportGitBranch]);

  const refreshStatus = useCallback(
    async (kind: "status" | "diff" = "status") => {
      const sequence = ++request.current;
      const latest = files.getStatus();
      synced.current = {
        projectId,
        sourcesVersion: latest.sourcesVersion,
        gitVersion: latest.gitVersion,
        hasRepo: synced.current?.hasRepo ?? null,
        failed: false,
      };
      try {
        const next = await gitAction({
          data: { projectId, action: { kind } },
        });
        if (sequence !== request.current) return;
        synced.current = {
          ...synced.current,
          hasRepo: Boolean(next.status.branch),
          failed: false,
        };
        setResult(next);
        setError((current) => (current?.source === "status" ? null : current));
      } catch (failure: unknown) {
        if (sequence !== request.current) return;
        synced.current = {
          ...synced.current,
          failed: true,
        };
        reportGitFailure(failure);
        setError({
          source: "status",
          message:
            failure instanceof Error ? failure.message : "Could not load git.",
        });
      }
    },
    [files, projectId, reportGitFailure],
  );

  useEffect(() => {
    const reopened = panelVisible && !wasVisible.current;
    wasVisible.current = panelVisible;
    const hasUnsavedDrafts = [...drafts.values()].some(
      (draft) => draft.value !== draft.savedValue,
    );
    const decision = decideGitStatusRefresh({
      visible: panelVisible,
      busy: Boolean(busy),
      projectId,
      sourcesVersion,
      gitVersion,
      hasUnsavedDrafts,
      reopened,
      synced: synced.current,
    });
    if (decision.kind === "hydrate") {
      synced.current = decision.synced;
      return;
    }
    if (decision.kind === "refresh")
      void refreshStatus(diffOpen ? "diff" : "status");
  }, [
    panelVisible,
    busy,
    projectId,
    sourcesVersion,
    gitVersion,
    drafts,
    diffOpen,
    refreshStatus,
  ]);

  async function save() {
    await files.refresh();
    for (const file of collaboration.values()) {
      const state = file.getStatus();
      if (!state.ready || !state.connected)
        throw new Error(
          "Reconnect all open files before using git. Your local drafts are kept.",
        );
      if (state.canWrite) await file.save();
    }
  }

  /** Saves, runs the action, and shows its result unless a later one started. */
  async function send(action: GitRequest) {
    const sequence = ++request.current;
    try {
      if (canWrite) await save();
      const next = await gitAction({ data: { projectId, action } });
      if (sequence !== request.current) return false;
      setResult(next);
      await files.refresh();
      const latest = files.getStatus();
      synced.current = {
        projectId,
        sourcesVersion: latest.sourcesVersion,
        gitVersion: latest.gitVersion,
        hasRepo: Boolean(next.status.branch),
        failed: false,
      };
      return true;
    } catch (failure) {
      if (sequence !== request.current) return false;
      throw failure;
    }
  }

  /** Whether the action's result is shown. */
  async function act(action: Exclude<GitAction, { kind: "import" | "link" }>) {
    setBusy(action.kind);
    setError(null);
    setNotice("");
    try {
      if (!(await send(action))) return false;
      if (action.kind === "commit") {
        setMessage("");
        removeSession(messageKey);
      }
      if (action.kind === "push") setNotice("Branch pushed.");
      if (action.kind === "pull") setNotice("Branch pulled.");
      return true;
    } catch (failure) {
      if (action.kind === "status") reportGitFailure(failure);
      setError({
        source: action.kind === "status" ? "status" : "action",
        message:
          failure instanceof Error
            ? failure.message
            : "Git action failed. Try again.",
      });
      return false;
    } finally {
      setBusy("");
    }
  }

  /** Rejects, so that the form which asked shows why. */
  async function link(remote: string) {
    setBusy("link");
    setError(null);
    try {
      await send({ kind: "link", remote });
    } finally {
      setBusy("");
    }
  }

  async function authorize(provider: GitProvider) {
    setBusy("authorize");
    setError(null);
    try {
      await connectGitAccount(provider);
    } catch (failure) {
      setError({
        source: "action",
        message:
          failure instanceof Error
            ? failure.message
            : "Could not connect account.",
      });
    } finally {
      setBusy("");
    }
  }

  /** Suggests a commit message. */
  async function generate() {
    setBusy("generate");
    setError(null);
    setNotice("");
    try {
      await save();
      const response = await fetch(`/api/ai/${projectId}?git-message=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(body);
        throw new Error(
          error.success ? error.data.error : "Could not generate a message.",
        );
      }
      changeMessage(z.object({ message: z.string() }).parse(body).message);
      setNotice("Review the suggested message before committing.");
    } catch (failure) {
      setError({
        source: "action",
        message:
          failure instanceof Error
            ? failure.message
            : "Could not generate a message.",
      });
    } finally {
      setBusy("");
    }
  }

  return {
    status: result?.status,
    diff: result?.diff,
    busy,
    error: error?.message,
    notice,
    message,
    changeMessage,
    retry() {
      setError(null);
      void refreshStatus();
    },
    act,
    link,
    authorize,
    generate,
  };
}

export type Git = ReturnType<typeof useGit>;
