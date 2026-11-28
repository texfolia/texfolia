import { Button } from "#/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "#/components/ui/context-menu";
import type { GitStatus } from "#/lib/git";
import { useWorkspaceActions } from "#/providers/workspace-provider";

import type { Git } from "../-hooks/use-git";

/** The files that changed since the last commit, and their diff once asked for. */
export function GitChanges({
  git,
  changes,
}: {
  git: Git;
  changes: GitStatus["changes"];
}) {
  const { reveal } = useWorkspaceActions();
  const reviewDiff = () => void git.act({ kind: "diff" });
  return (
    <>
      <div>
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Changes ({changes.length})</h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={!!git.busy}
            onClick={reviewDiff}
          >
            Review diff
          </Button>
        </div>
        {changes.length ? (
          <ul className="max-h-36 overflow-auto">
            {changes.map((change) => (
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
                    <ContextMenuItem onClick={reviewDiff}>
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
      {git.diff && (
        <pre
          tabIndex={0}
          aria-label="Working tree diff"
          className="bg-muted focus-visible:ring-ring max-h-64 overflow-auto rounded p-2 text-xs outline-none focus-visible:ring-2"
        >
          {git.diff}
        </pre>
      )}
    </>
  );
}
