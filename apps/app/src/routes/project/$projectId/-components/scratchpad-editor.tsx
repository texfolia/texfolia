import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useSyncExternalStore } from "react";

import { scratchpadId } from "#/lib/collaboration";
import {
  useWorkspace,
  useWorkspaceActions,
} from "#/providers/workspace-provider";

import { scratchpadTitle } from "../-hooks/use-dock-panels";
import { DocumentEditor } from "./document-editor";

const emptySubscribe = () => () => {};

/** The project's shared Markdown notes, which are not a project file. */
export function ScratchpadEditor({ api }: IDockviewPanelProps) {
  const { openMarkdownPreview } = useWorkspaceActions();
  const { scratchpad, formatSettings } = useWorkspace();
  const canWrite = useSyncExternalStore(
    scratchpad?.subscribe ?? emptySubscribe,
    () => scratchpad?.getStatus().canWrite,
  );
  const openPreview = useCallback(
    () => openMarkdownPreview(scratchpadId),
    [openMarkdownPreview],
  );
  return (
    <DocumentEditor
      id={scratchpadId}
      panelApi={api}
      collaboration={scratchpad}
      // The server decides, because draft recovery only pauses source edits.
      canWrite
      // Names the language and the downloaded copy.
      filename="scratchpad.md"
      labels={{
        title: scratchpadTitle,
        region: "Scratchpad editor",
        source: "Scratchpad",
        placeholder: canWrite
          ? "Shared Markdown notes for this project…"
          : "No notes yet.",
      }}
      autosaved
      allowOpenFile={false}
      formatSettings={formatSettings}
      onOpenPreview={openPreview}
    />
  );
}
