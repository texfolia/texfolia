import { useMemo } from "react";

import type { AssistantEditor, RevertOutcome } from "#/lib/ai/editor";
import { type AssistantChange, revertEdits } from "#/lib/ai/revert";
import type { Store } from "#/lib/external-store";
import { projectNodePaths, projectPaths } from "#/lib/projects";
import { useProjectFiles } from "#/providers/project-files-provider";
import {
  useWorkspace,
  useWorkspaceActions,
} from "#/providers/workspace-provider";

type Result = Omit<RevertOutcome, "change">;

const changedReason = "The text has changed since.";
const deletedReason = "The file was deleted.";

function editResult(
  outcomes: ReturnType<typeof revertEdits>["outcomes"],
): Result {
  const conflicts = outcomes.filter((outcome) => outcome === "conflict").length;
  if (!conflicts)
    return {
      outcome: outcomes.includes("reverted") ? "reverted" : "already",
    };
  if (!outcomes.includes("reverted"))
    return { outcome: "skipped", reason: changedReason };
  return {
    outcome: "partial",
    reason: `${conflicts} of ${outcomes.length} edits were left alone because their text has changed since.`,
  };
}

/**
 * Lets the assistant's panel act on the workspace. Changes are undone as edits
 * of the live documents, so everyone sees them and Undo takes them back.
 */
export function useAssistantEditor(
  prompt: Store<string | null>,
): AssistantEditor {
  const { canWrite, paths } = useWorkspace();
  const { editDocument, reveal } = useWorkspaceActions();
  const files = useProjectFiles();
  return useMemo(() => {
    async function undo(change: AssistantChange): Promise<Result> {
      const nodes = files.nodes.toArray;
      switch (change.kind) {
        case "edit": {
          if (!files.nodes.has(change.nodeId))
            return { outcome: "skipped", reason: deletedReason };
          let outcomes: ReturnType<typeof revertEdits>["outcomes"] = [];
          await editDocument(
            change.nodeId,
            (file) => {
              const reverted = revertEdits(file.text.toString(), change.edits);
              outcomes = reverted.outcomes;
              if (reverted.changes.length) file.applyEdits(reverted.changes);
            },
            { latest: true },
          );
          return editResult(outcomes);
        }
        case "create": {
          if (!files.nodes.has(change.nodeId)) return { outcome: "already" };
          let unchanged = false;
          await editDocument(
            change.nodeId,
            (file) => {
              unchanged = file.text.toString() === change.content;
            },
            { latest: true },
          );
          if (!unchanged) return { outcome: "skipped", reason: changedReason };
          await files.nodes.delete(change.nodeId).when("settled");
          await files.refresh();
          return { outcome: "reverted" };
        }
        case "rename": {
          const all = projectNodePaths(nodes);
          const current = all.get(change.nodeId);
          if (current === undefined)
            return { outcome: "skipped", reason: deletedReason };
          if (current === change.path) return { outcome: "already" };
          if (current !== change.newPath)
            return {
              outcome: "skipped",
              reason: "It has been renamed or moved since.",
            };
          const at = change.path.lastIndexOf("/");
          const folder = nodes.find(
            (node) =>
              node.kind === "folder" &&
              (at < 0
                ? node.parentId === null
                : node.parentId !== null &&
                  all.get(node.id) === change.path.slice(0, at)),
          );
          if (!folder)
            return {
              outcome: "skipped",
              reason: "Its earlier folder no longer exists.",
            };
          await files.rename(
            change.nodeId,
            change.path.slice(at + 1),
            folder.id,
          );
          return { outcome: "reverted" };
        }
        case "delete":
          return [...projectPaths(nodes).values()].includes(change.path)
            ? { outcome: "already" }
            : {
                outcome: "skipped",
                reason: "Deleted files cannot be restored from a chat.",
              };
        case "git":
          return {
            outcome: "skipped",
            reason: "Use the Git view to undo what Git changed.",
          };
      }
    }
    return {
      canWrite,
      files: [...paths.values()],
      reveal: (path) => reveal(path),
      prompt,
      async revert(changes) {
        // Files that the assistant has just created or moved.
        await files.refresh().catch(() => {});
        const outcomes: RevertOutcome[] = [];
        // In turn, because a change can build on the one before it.
        for (const change of changes) {
          try {
            outcomes.push({ change, ...(await undo(change)) });
          } catch (failure) {
            outcomes.push({
              change,
              outcome: "skipped",
              reason:
                failure instanceof Error
                  ? failure.message
                  : "It could not be undone. Try again.",
            });
          }
        }
        return outcomes;
      },
    };
  }, [canWrite, paths, prompt, editDocument, reveal, files]);
}
