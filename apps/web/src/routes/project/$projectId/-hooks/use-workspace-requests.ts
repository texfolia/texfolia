import { useState } from "react";

import { selectionPrompt } from "#/lib/ai/editor";
import { sourceToPdf, type SyncTexIndex } from "#/lib/editor/latex/synctex";
import { selectedLines } from "#/lib/editor/selection";
import { createStore } from "#/lib/external-store";
import type { WorkspaceChrome } from "#/lib/workspace/workspace-layout";
import type { WorkspaceBuild } from "#/providers/workspace-provider";

import type { SearchRequest } from "../-components/project-search";
import type { useDockPanels } from "./use-dock-panels";

/** What the editor asks the panels around it to show. */
export function useWorkspaceRequests({
  activePath,
  panels,
  build,
  synctex,
  updateChrome,
}: {
  activePath: string | undefined;
  panels: Pick<
    ReturnType<typeof useDockPanels>,
    "activeEditor" | "openGenerated"
  >;
  build: WorkspaceBuild["build"];
  synctex: SyncTexIndex | null;
  updateChrome: (patch: Partial<WorkspaceChrome>) => void;
}) {
  const [pdfJump, setPdfJump] = useState<WorkspaceBuild["pdfJump"]>(null);
  const [searchRequest, setSearchRequest] = useState<SearchRequest>({
    sequence: 0,
  });

  function revealPdf(path: string, line: number) {
    const pdfPath = build?.artifacts?.pdf;
    if (!synctex || !pdfPath) return;
    const location = sourceToPdf(synctex, path, line);
    if (!location) return;
    panels.openGenerated(pdfPath, true);
    setPdfJump({ index: synctex, location });
  }

  function openSearch() {
    // Seed the query from a single-line selection, like VS Code's Find in Files.
    const view = panels.activeEditor();
    const selection = view?.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    );
    updateChrome({ rightOpen: true, rightView: "search" });
    setSearchRequest((previous) => ({
      sequence: previous.sequence + 1,
      query: selection && !/[\r\n]/.test(selection) ? selection : undefined,
    }));
  }

  // Kept outside React until a chat takes it.
  const [assistantPrompt] = useState(() => createStore<string | null>(null));
  function askAi(prompt: string) {
    updateChrome({ agentsOpen: true });
    assistantPrompt.set(prompt);
  }
  function askAboutSelection() {
    const view = panels.activeEditor();
    if (view && activePath)
      askAi(selectionPrompt(activePath, selectedLines(view.state)));
  }

  return {
    pdfJump,
    revealPdf,
    searchRequest,
    openSearch,
    assistantPrompt,
    askAi,
    askAboutSelection,
  };
}
