import { IconRefresh } from "@tabler/icons-react";
import { useId, useState } from "react";

import { GitRemoteForm } from "#/components/git-remote-form";
import { Button } from "#/components/ui/button";
import { Label } from "#/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { gitProvider, gitProviders, type GitStatus } from "#/lib/git";
import { useWorkspace } from "#/providers/workspace-provider";

import { type Git, useGit } from "../-hooks/use-git";
import { GitChanges } from "./git-changes";
import { GitBranchForm, GitCommitForm } from "./git-commit";

const hostedNotice =
  "Texfolia no longer hosts Git repositories. This project still has history stored here. Link an empty repository to push it, or remove it.";

export function GitPanel({ visible }: { visible: boolean }) {
  const { canWrite } = useWorkspace();
  const git = useGit(visible);
  const { status, error, notice, busy } = git;
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
          <Button size="sm" variant="ghost" onClick={git.retry}>
            Try again
          </Button>
        )}
        {status && !status.remote && <GitUnlinked git={git} status={status} />}
        {status?.branch && status.remote && (
          <>
            <GitRemote git={git} status={status} remote={status.remote} />
            <GitChanges git={git} changes={status.changes} />
            {canWrite && (
              <>
                <GitCommitForm git={git} />
                <GitBranchForm git={git} />
              </>
            )}
            <GitCommits commits={status.commits} />
            {canWrite && <GitUnlink git={git} />}
          </>
        )}
      </div>
    </section>
  );
}

function GitUnlinked({ git, status }: { git: Git; status: GitStatus }) {
  const { canWrite } = useWorkspace();
  // A repository from the removed in-app initialize: history, but no remote.
  const hosted = !!status.branch;
  if (!canWrite)
    return (
      <p className="text-muted-foreground">
        {hosted ? hostedNotice : "No repository is linked."}
      </p>
    );
  return (
    <>
      <div className="space-y-3">
        <p className="font-medium">Link a repository</p>
        <p className="text-muted-foreground">
          {hosted
            ? hostedNotice
            : `Git is optional and works through ${gitProviders.map((p) => p.label).join(" or ")}. Link an empty repository to commit, push and pull this project.`}
        </p>
        <GitRemoteForm mode="link" disabled={!!git.busy} onConnect={git.link} />
      </div>
      {hosted && (
        <Button
          size="sm"
          variant="ghost"
          disabled={!!git.busy}
          onClick={() => void git.act({ kind: "unlink" })}
        >
          {git.busy === "unlink" ? "Removing…" : "Remove stored history"}
        </Button>
      )}
    </>
  );
}

function GitRemote({
  git,
  status,
  remote,
}: {
  git: Git;
  status: GitStatus;
  remote: NonNullable<GitStatus["remote"]>;
}) {
  const { canWrite } = useWorkspace();
  const { act } = git;
  const busy = !!git.busy;
  const branchId = useId();
  const url = remote.url.replace(/\.git$/, "");
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <a
          className="min-w-0 flex-1 truncate underline underline-offset-4"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          {url.replace(/^https:\/\//, "")}
        </a>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh git"
          disabled={busy}
          onClick={() => void act({ kind: "status" })}
        >
          <IconRefresh />
        </Button>
      </div>
      {canWrite && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void git.authorize(remote.provider)}
        >
          Connect {gitProvider(remote.provider).label} access
        </Button>
      )}
      <div className="space-y-1">
        <Label htmlFor={branchId} className="text-xs font-normal">
          Current branch
        </Label>
        <NativeSelect
          id={branchId}
          className="w-full [&_select]:text-xs"
          value={status.branch ?? ""}
          disabled={!canWrite || busy}
          onChange={(event) =>
            void act({ kind: "checkout", name: event.target.value })
          }
        >
          {[
            ...new Set([
              ...(status.branch ? [status.branch] : []),
              ...status.branches,
            ]),
          ].map((name) => (
            <NativeSelectOption key={name} value={name}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {canWrite && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void act({ kind: "fetch" })}
        >
          Refresh branches
        </Button>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!canWrite || busy}
          onClick={() => void act({ kind: "pull" })}
        >
          {git.busy === "pull" ? "Pulling…" : "Pull"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canWrite || busy || !status.commits.length}
          onClick={() => void act({ kind: "push" })}
        >
          {git.busy === "push" ? "Pushing…" : "Push"}
        </Button>
      </div>
    </>
  );
}

function GitCommits({ commits }: { commits: GitStatus["commits"] }) {
  return (
    <details>
      <summary className="focus-visible:ring-ring cursor-pointer rounded-sm py-1 font-medium outline-none focus-visible:ring-2">
        Recent commits ({commits.length})
      </summary>
      <ol className="max-h-52 space-y-2 overflow-auto py-2">
        {commits.map((commit) => (
          <li key={commit.oid}>
            <p className="break-words whitespace-pre-wrap">{commit.message}</p>
            <p className="text-muted-foreground">
              {commit.oid.slice(0, 7)} · {commit.author}
            </p>
          </li>
        ))}
      </ol>
      {!commits.length && (
        <p className="text-muted-foreground">
          Make your first commit to start history.
        </p>
      )}
    </details>
  );
}

function GitUnlink({ git }: { git: Git }) {
  const [confirming, setConfirming] = useState(false);
  const busy = !!git.busy;
  if (!confirming)
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        Unlink repository
      </Button>
    );
  return (
    <div className="space-y-2">
      <p>
        Unlink this remote? Project files stay here. Local commits and branches
        will be removed; push them first to keep them.
      </p>
      <Button
        size="sm"
        variant="destructive"
        disabled={busy}
        onClick={() => void git.act({ kind: "unlink" })}
      >
        Unlink remote
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </Button>
    </div>
  );
}
