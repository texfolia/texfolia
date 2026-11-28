import { IconSparkles, IconTrash } from "@tabler/icons-react";
import { Button } from "@texfolia/ui/button";
import { useState } from "react";

import { problemPrompt } from "#/lib/ai/editor";
import {
  useWorkspace,
  useWorkspaceActions,
  useWorkspaceDiagnostics,
} from "#/providers/workspace-provider";

export function WorkspaceProblems() {
  const { reveal, addReference, askAi, deleteNode } = useWorkspaceActions();
  const { canWrite } = useWorkspace();
  const { allProblems } = useWorkspaceDiagnostics();
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  return (
    <section
      aria-label="LaTeX problems"
      className="h-full overflow-auto p-3 text-sm"
    >
      {deleteError && (
        <p role="alert" className="text-destructive pb-2 text-xs">
          {deleteError}
        </p>
      )}
      {allProblems.length ? (
        <ul className="space-y-1">
          {allProblems.map((problem, index) => (
            <li
              key={`${problem.path}:${problem.line}:${index}`}
              className="flex items-start gap-1"
            >
              <Button
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start gap-3 text-left whitespace-normal"
                onClick={() => reveal(problem.path, problem.line)}
              >
                <span
                  className={
                    problem.severity === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {problem.unusedAsset
                    ? problem.path
                    : `${problem.path}:${problem.line}`}
                </span>
                {problem.message}
              </Button>
              {canWrite && problem.severity !== "info" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  aria-label={`Fix with AI: ${problem.message}`}
                  onClick={() => askAi(problemPrompt(problem))}
                >
                  <IconSparkles />
                  Fix with AI
                </Button>
              )}
              {problem.citation && canWrite && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => addReference(problem.citation?.key)}
                >
                  Add reference
                </Button>
              )}
              {problem.unusedAsset && canWrite && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive shrink-0"
                  disabled={deletingPath === problem.unusedAsset.path}
                  aria-label={`Delete unused image ${problem.unusedAsset.path}`}
                  onClick={() => {
                    const assetPath = problem.unusedAsset?.path;
                    if (!assetPath) return;
                    setDeleteError("");
                    setDeletingPath(assetPath);
                    deleteNode(assetPath)
                      .catch((error: unknown) =>
                        setDeleteError(
                          error instanceof Error
                            ? error.message
                            : `Could not delete ${assetPath}. Try again.`,
                        ),
                      )
                      .finally(() =>
                        setDeletingPath((current) =>
                          current === assetPath ? null : current,
                        ),
                      );
                  }}
                >
                  <IconTrash />
                  {deletingPath === problem.unusedAsset.path
                    ? "Deleting…"
                    : "Delete"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No problems.</p>
      )}
    </section>
  );
}
