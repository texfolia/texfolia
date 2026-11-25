import { useState } from "react";

import { addLatexPackage, packageInsertion } from "#/lib/editor/latex/symbols";
import { isMainFileCandidate } from "#/lib/projects";
import type { useProjectFiles } from "#/providers/project-files-provider";

import type { useCollaborationFiles } from "./use-collaboration-files";
import type { useDockPanels } from "./use-dock-panels";

/** Changes which file is the main document, and the packages it loads. */
export function useMainDocument({
  writable,
  files,
  main,
  mainId,
  activePath,
  panels,
  collaboration,
}: {
  writable: boolean;
  files: ReturnType<typeof useProjectFiles>;
  main: string | undefined;
  mainId: string | undefined;
  /** The file on screen, which can become the main document. */
  activePath: string | undefined;
  panels: Pick<ReturnType<typeof useDockPanels>, "editor">;
  collaboration: Pick<ReturnType<typeof useCollaborationFiles>, "edit">;
}) {
  const [error, setError] = useState("");
  const canSetMain =
    writable &&
    !!activePath &&
    activePath !== main &&
    isMainFileCandidate(activePath);
  async function setMain() {
    if (!activePath) return;
    setError("");
    try {
      await files.setMainFile(activePath);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The main document could not be changed. Try again.",
      );
    }
  }

  function addSymbolPackage(packageName: string) {
    if (!writable || !mainId) return;
    const view = panels.editor(mainId);
    if (view) {
      addLatexPackage(packageName)(view);
      return;
    }
    collaboration
      .edit(mainId, (file) => {
        const value = file.text.toString();
        const insertion = packageInsertion(value, packageName);
        if (insertion)
          file.replace(
            value.slice(0, insertion.from) +
              insertion.insert +
              value.slice(insertion.from),
          );
      })
      .catch((error: unknown) =>
        console.error("Package was not added", { packageName, error }),
      );
  }

  return { error, canSetMain, setMain, addSymbolPackage };
}
