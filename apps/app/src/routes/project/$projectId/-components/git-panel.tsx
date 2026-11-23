import { IconRefresh } from "@tabler/icons-react";
import {
  gitProvider,
  gitProviders,
  type GitAction,
  type GitResult,
} from "@texfolia/git";
import { Button } from "@texfolia/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@texfolia/ui/context-menu";
import { Input } from "@texfolia/ui/input";
import { Textarea } from "@texfolia/ui/textarea";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { GitRemoteForm, connectGitAccount } from "#/components/git-remote-form";
import { gitAction } from "#/lib/git.functions";
import { useProjectFiles } from "#/providers/project-files-provider";
import { useWorkspace } from "#/providers/workspace-provider";

const hostedNotice =
  "Texfolia no longer hosts Git repositories. This project still has history stored here. Link an empty repository to push it, or remove it.";

export function GitPanel() {
  const {
    projectId,
    canWrite,
    collaboration,
    reveal,
    reportGitBranch,
    reportGitFailure,
  } = useWorkspace();
  const files = useProjectFiles();
  const [result, setResult] = useState<GitResult | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [message, setMessage] = useState("");
  const messageKey = `texfolia.git-message.${projectId}`;
  useEffect(() => {
    setMessage(sessionStorage.getItem(messageKey) ?? "");
  }, [messageKey]);
  function changeMessage(value: string) {
    setMessage(value);
    sessionStorage.setItem(messageKey, value);
  }
  const [branch, setBranch] = useState("");
  const [unlinking, setUnlinking] = useState(false);
  const visible = true;
  useEffect(() => {
    if (result) reportGitBranch(result.status.branch);
  }, [result, reportGitBranch]);
  useEffect(() => {
    if (busy || !visible || !result?.status.branch || result.diff) return;
    let active = true;
    const timer = setInterval(() => {
      void gitAction({ data: { projectId, action: { kind: "status" } } })
        .then((next) => {
          if (active) setResult(next);
        })
        .catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, busy, visible, result?.status.branch, result?.diff]);
  const load = useCallback(
    async () =>
      setResult(
        await gitAction({ data: { projectId, action: { kind: "status" } } }),
      ),
    [projectId],
  );
  useEffect(() => {
    void load().catch((error: unknown) => {
      reportGitFailure(error);
      setError(error instanceof Error ? error.message : "Could not load git.");
    });
  }, [load, reportGitFailure]);
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
  async function act(action: Exclude<GitAction, { kind: "import" | "link" }>) {
    setBusy(action.kind);
    setError("");
    setNotice("");
    try {
      if (canWrite) await save();
      setResult(await gitAction({ data: { projectId, action } }));
      await files.refresh();
      if (action.kind === "commit") {
        setMessage("");
        sessionStorage.removeItem(messageKey);
      }
      if (action.kind === "branch") setBranch("");
      if (action.kind === "unlink") setUnlinking(false);
      if (action.kind === "push") setNotice("Branch pushed.");
      if (action.kind === "pull") setNotice("Branch pulled.");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Git action failed. Try again.",
      );
    } finally {
      setBusy("");
    }
  }
  async function generate() {
    setBusy("generate");
    setError("");
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
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not generate a message.",
      );
    } finally {
      setBusy("");
    }
  }
  const status = result?.status;
  // A repository from the removed in-app initialize: history, but no remote.
  const hosted = !!status && !status.remote && !!status.branch;
  return (
    <section aria-label="Git" data-testid="git-panel">
      <div className="space-y-3 p-2 text-xs" aria-busy={!!busy}>
        {error && (
          <p
            role="alert"
            className="text-destructive break-words whitespace-pre-wrap"
          >
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {!status && !error && <p role="status">Loading repository…</p>}
        {!status && error && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError("");
              void load().catch((error: unknown) =>
                setError(
                  error instanceof Error
                    ? error.message
                    : "Could not load git.",
                ),
              );
            }}
          >
            Try again
          </Button>
        )}
        {status &&
          !status.remote &&
          (canWrite ? (
            <div className="space-y-3">
              <p className="font-medium">Link a repository</p>
              <p className="text-muted-foreground">
                {hosted
                  ? hostedNotice
                  : `Git is optional and works through ${gitProviders.map((p) => p.label).join(" or ")}. Link an empty repository to commit, push and pull this project.`}
              </p>
              <GitRemoteForm
                mode="link"
                disabled={!!busy}
                onConnect={async (url) => {
                  setBusy("link");
                  try {
                    await save();
                    setResult(
                      await gitAction({
                        data: {
                          projectId,
                          action: { kind: "link", remote: url },
                        },
                      }),
                    );
                  } finally {
                    setBusy("");
                  }
                }}
              />
            </div>
          ) : (
            <p className="text-muted-foreground">
              {hosted ? hostedNotice : "No repository is linked."}
            </p>
          ))}
        {hosted && canWrite && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => void act({ kind: "unlink" })}
          >
            {busy === "unlink" ? "Removing…" : "Remove stored history"}
          </Button>
        )}
        {status?.branch && status.remote && (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {status.remote && (
                <a
                  className="min-w-0 flex-1 truncate underline underline-offset-4"
                  href={status.remote.url.replace(/\.git$/, "")}
                  target="_blank"
                  rel="noreferrer"
                >
                  {status.remote.url
                    .replace(/^https:\/\//, "")
                    .replace(/\.git$/, "")}
                </a>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh git"
                disabled={!!busy}
                onClick={() => void act({ kind: "status" })}
              >
                <IconRefresh />
              </Button>
            </div>
            {canWrite && status.remote && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={async () => {
                  setBusy("authorize");
                  setError("");
                  try {
                    if (status.remote)
                      await connectGitAccount(status.remote.provider);
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Could not connect account.",
                    );
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Connect {gitProvider(status.remote.provider).label} access
              </Button>
            )}
            <label className="block space-y-1">
              <span>Current branch</span>
              <select
                className="border-input bg-background w-full rounded-md border px-2 py-1.5"
                value={status.branch ?? ""}
                disabled={!canWrite || !!busy}
                onChange={(e) =>
                  void act({ kind: "checkout", name: e.target.value })
                }
              >
                {[
                  ...new Set([
                    ...(status.branch ? [status.branch] : []),
                    ...status.branches,
                  ]),
                ].map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            {canWrite && status.remote && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void act({ kind: "fetch" })}
              >
                Refresh branches
              </Button>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={!canWrite || !status.remote || !!busy}
                onClick={() => void act({ kind: "pull" })}
              >
                {busy === "pull" ? "Pulling…" : "Pull"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  !canWrite ||
                  !status.remote ||
                  !!busy ||
                  !status.commits.length
                }
                onClick={() => void act({ kind: "push" })}
              >
                {busy === "push" ? "Pushing…" : "Push"}
              </Button>
            </div>
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-medium">
                  Changes ({status.changes.length})
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => void act({ kind: "diff" })}
                >
                  Review diff
                </Button>
              </div>
              {status.changes.length ? (
                <ul className="max-h-36 overflow-auto">
                  {status.changes.map((change) => (
                    <li key={change.path}>
                      <ContextMenu>
                        <ContextMenuTrigger
                          render={<div />}
                          className="flex gap-2 py-0.5"
                        >
                          <span className="text-muted-foreground w-14 shrink-0">
                            {change.status}
                          </span>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-auto min-w-0 justify-start text-left whitespace-normal"
                            onClick={() => reveal(change.path)}
                          >
                            {change.path}
                          </Button>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            disabled={change.status === "deleted"}
                            onClick={() => reveal(change.path)}
                          >
                            Open file
                          </ContextMenuItem>
                          <ContextMenuItem
                            onClick={() => void act({ kind: "diff" })}
                          >
                            Review diff
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">Working tree is clean.</p>
              )}
            </div>
            {result?.diff && (
              <pre
                tabIndex={0}
                aria-label="Working tree diff"
                className="bg-muted max-h-64 overflow-auto rounded p-2 text-xs"
              >
                {result.diff}
              </pre>
            )}
            {canWrite && (
              <>
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ kind: "commit", message });
                  }}
                >
                  <label className="block space-y-1">
                    <span>Commit message</span>
                    <Textarea
                      required
                      maxLength={5000}
                      value={message}
                      onChange={(e) => changeMessage(e.target.value)}
                      disabled={!!busy}
                      className="min-h-16 text-xs"
                    />
                  </label>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      type="submit"
                      disabled={!!busy || !message.trim()}
                    >
                      {busy === "commit" ? "Committing…" : "Commit changes"}
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => void generate()}
                    >
                      {busy === "generate"
                        ? "Generating…"
                        : "Generate message · Pro"}
                    </Button>
                  </div>
                  <p className="text-muted-foreground">
                    AI usage is metered. Ignored files and out/ are excluded.
                  </p>
                </form>
                <form
                  className="flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act({ kind: "branch", name: branch });
                  }}
                >
                  <Input
                    aria-label="New branch name"
                    placeholder="New branch name"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    disabled={!!busy}
                    required
                    className="min-w-0 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    type="submit"
                    disabled={!!busy || !branch.trim()}
                  >
                    Create
                  </Button>
                </form>
              </>
            )}
            <details>
              <summary className="cursor-pointer py-1 font-medium">
                Recent commits ({status.commits.length})
              </summary>
              <ol className="max-h-52 space-y-2 overflow-auto py-2">
                {status.commits.map((commit) => (
                  <li key={commit.oid}>
                    <p className="break-words whitespace-pre-wrap">
                      {commit.message}
                    </p>
                    <p className="text-muted-foreground">
                      {commit.oid.slice(0, 7)} · {commit.author}
                    </p>
                  </li>
                ))}
              </ol>
              {!status.commits.length && (
                <p className="text-muted-foreground">
                  Make your first commit to start history.
                </p>
              )}
            </details>
            {canWrite &&
              status.remote &&
              (unlinking ? (
                <div className="space-y-2">
                  <p>
                    Unlink this remote? Project files stay here. Local commits
                    and branches will be removed; push them first to keep them.
                  </p>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!!busy}
                    onClick={() => void act({ kind: "unlink" })}
                  >
                    Unlink remote
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => setUnlinking(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy}
                  onClick={() => setUnlinking(true)}
                >
                  Unlink repository
                </Button>
              ))}
          </>
        )}
      </div>
    </section>
  );
}
